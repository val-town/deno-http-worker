use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use http_body_util::{BodyExt, Empty, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, Response};
use hyper_util::client::legacy::Client;
use hyperlocal::UnixConnector;
use serde_json::Value;
use tokio::fs;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, timeout};
use uuid::Uuid;

pub type Body =
    http_body_util::combinators::BoxBody<Bytes, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Debug, thiserror::Error)]
pub enum DenoWorkerError {
    #[error("Deno process exited early: {message}")]
    EarlyExit {
        message: String,
        stderr: String,
        stdout: String,
        code: Option<i32>,
        signal: String,
    },
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("HTTP error: {0}")]
    Http(#[from] hyper::Error),
    #[error("HTTP request error: {0}")]
    HttpRequest(#[from] hyper::http::Error),
    #[error("HTTP client error: {0}")]
    HttpClient(#[from] hyper_util::client::legacy::Error),
    #[error("Timeout waiting for socket file")]
    SocketTimeout,
    #[error("Failed to parse response: {0}")]
    ParseResponse(#[from] serde_json::Error),
}

pub struct DenoWorkerOptions {
    pub deno_executable: Vec<String>,
    pub deno_bootstrap_script_path: PathBuf,
    pub run_flags: Vec<String>,
    pub print_output: bool,
    pub print_command_and_arguments: bool,
}

impl Default for DenoWorkerOptions {
    fn default() -> Self {
        Self {
            deno_executable: vec!["deno".to_string()],
            deno_bootstrap_script_path: PathBuf::from("../deno-bootstrap/index.ts"),
            run_flags: vec![],
            print_output: false,
            print_command_and_arguments: false,
        }
    }
}

pub struct DenoHTTPWorker {
    socket_path: PathBuf,
    process: Arc<Mutex<Option<Child>>>,
    client: Client<UnixConnector, Body>,
    exit_sender: broadcast::Sender<(Option<i32>, String)>,
    _exit_receiver: broadcast::Receiver<(Option<i32>, String)>,
}

impl DenoHTTPWorker {
    pub async fn new(script: &str, options: DenoWorkerOptions) -> Result<Self, DenoWorkerError> {
        let socket_file = std::env::temp_dir().join(format!("{}-deno-http.sock", Uuid::new_v4()));
        let allow_read_value = socket_file.to_string_lossy().to_string();
        let script_args = vec![
            socket_file.to_string_lossy().to_string(),
            "script".to_string(),
            script.to_string(),
        ];

        Self::create_worker(socket_file, allow_read_value, script_args, options).await
    }

    pub async fn new_from_url(
        url: &str,
        options: DenoWorkerOptions,
    ) -> Result<Self, DenoWorkerError> {
        let socket_file = std::env::temp_dir().join(format!("{}-deno-http.sock", Uuid::new_v4()));
        let url_path = url.replace("file://", "");
        let allow_read_value = format!("{},{}", socket_file.to_string_lossy(), url_path);
        let script_args = vec![
            socket_file.to_string_lossy().to_string(),
            "import".to_string(),
            url.to_string(),
        ];

        Self::create_worker(socket_file, allow_read_value, script_args, options).await
    }

    async fn create_worker(
        socket_file: PathBuf,
        allow_read_value: String,
        script_args: Vec<String>,
        options: DenoWorkerOptions,
    ) -> Result<Self, DenoWorkerError> {
        let run_flags =
            Self::prepare_run_flags(options.run_flags.clone(), &allow_read_value, &socket_file);
        let child = Self::spawn_deno_process(&options, run_flags, script_args)?;
        let (process, exit_sender, exit_receiver) =
            Self::monitor_process(child, socket_file.clone(), options.print_output).await;

        Self::wait_for_socket(&socket_file).await?;

        let client = Self::create_http_client();
        let mut worker = Self {
            socket_path: socket_file,
            process,
            client,
            exit_sender,
            _exit_receiver: exit_receiver,
        };

        worker.warm_request().await?;
        Ok(worker)
    }

    fn prepare_run_flags(
        mut run_flags: Vec<String>,
        allow_read_value: &str,
        socket_file: &Path,
    ) -> Vec<String> {
        let allow_write_value = socket_file.to_string_lossy().to_string();
        let mut allow_read_found = false;
        let mut allow_write_found = false;

        for flag in &mut run_flags {
            if flag == "--allow-read" || flag == "--allow-all" {
                allow_read_found = true;
            }
            if flag == "--allow-write" || flag == "--allow-all" {
                allow_write_found = true;
            }
            if flag.starts_with("--allow-read=") {
                allow_read_found = true;
                flag.push_str(&format!(",{}", allow_read_value));
            }
            if flag.starts_with("--allow-write=") {
                allow_write_found = true;
                flag.push_str(&format!(",{}", allow_write_value));
            }
        }

        if !allow_read_found {
            run_flags.push(format!("--allow-read={}", allow_read_value));
        }
        if !allow_write_found {
            run_flags.push(format!("--allow-write={}", allow_write_value));
        }

        run_flags
    }

    fn spawn_deno_process(
        options: &DenoWorkerOptions,
        run_flags: Vec<String>,
        script_args: Vec<String>,
    ) -> Result<Child, DenoWorkerError> {
        let command = &options.deno_executable[0];
        let mut args = Vec::new();
        args.extend_from_slice(&options.deno_executable[1..]);
        args.push("run".to_string());
        args.extend(run_flags);
        args.push(
            options
                .deno_bootstrap_script_path
                .to_string_lossy()
                .to_string(),
        );
        args.extend(script_args);

        if options.print_command_and_arguments {
            println!("Spawning deno process: {} {:?}", command, args);
        }

        let child = Command::new(command)
            .args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()?;

        Ok(child)
    }

    async fn monitor_process(
        mut child: Child,
        socket_file: PathBuf,
        print_output: bool,
    ) -> (
        Arc<Mutex<Option<Child>>>,
        broadcast::Sender<(Option<i32>, String)>,
        broadcast::Receiver<(Option<i32>, String)>,
    ) {
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        let (exit_sender, exit_receiver) = broadcast::channel(1);
        let exit_sender_clone = exit_sender.clone();
        let socket_path_clone = socket_file.clone();

        let process = Arc::new(Mutex::new(Some(child)));
        let process_clone = process.clone();

        tokio::spawn(async move {
            let mut child = process_clone.lock().await.take();
            if let Some(ref mut child) = child {
                let exit_status = child.wait().await;
                let _ = fs::remove_file(&socket_path_clone).await;

                let (code, signal) = match exit_status {
                    Ok(status) => (status.code(), "".to_string()),
                    Err(_) => (None, "SIGKILL".to_string()),
                };

                let _ = exit_sender_clone.send((code, signal));
            }
        });

        // Handle output streams
        if print_output {
            Self::handle_output_streams(stdout, stderr).await;
        }

        (process, exit_sender, exit_receiver)
    }

    async fn handle_output_streams(
        stdout: tokio::process::ChildStdout,
        stderr: tokio::process::ChildStderr,
    ) {
        tokio::spawn(async move {
            let mut stdout_reader = BufReader::new(stdout);
            let mut line = String::new();
            while stdout_reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                print!("[deno] {}", line);
                line.clear();
            }
        });

        tokio::spawn(async move {
            let mut stderr_reader = BufReader::new(stderr);
            let mut line = String::new();
            while stderr_reader.read_line(&mut line).await.unwrap_or(0) > 0 {
                eprint!("[deno] {}", line);
                line.clear();
            }
        });
    }

    async fn wait_for_socket(socket_file: &Path) -> Result<(), DenoWorkerError> {
        let socket_wait_timeout = Duration::from_secs(10);
        timeout(socket_wait_timeout, async {
            loop {
                if socket_file.exists() {
                    break;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .map_err(|_| DenoWorkerError::SocketTimeout)?;

        Ok(())
    }

    fn create_http_client() -> Client<UnixConnector, Body> {
        let connector = UnixConnector;
        Client::builder(hyper_util::rt::TokioExecutor::new()).build::<_, Body>(connector)
    }

    async fn warm_request(&mut self) -> Result<(), DenoWorkerError> {
        let uri = hyperlocal::Uri::new(&self.socket_path, "/");
        let req = Request::builder().uri(uri).body(
            Empty::<Bytes>::new()
                .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                .boxed(),
        )?;

        let resp = self.client.request(req).await?;
        let _body = resp.collect().await?;
        Ok(())
    }

    pub async fn request(
        &self,
        url: &str,
        method: Method,
        headers: HashMap<String, String>,
        body: Option<String>,
    ) -> Result<Response<hyper::body::Incoming>, DenoWorkerError> {
        let uri = hyperlocal::Uri::new(&self.socket_path, "/");

        let mut req_builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("X-Deno-Worker-URL", url);

        // Add custom headers
        for (key, value) in headers {
            // Handle special headers that might conflict
            if key.to_lowercase() == "host" {
                req_builder = req_builder.header("X-Deno-Worker-Host", value);
            } else if key.to_lowercase() == "connection" {
                req_builder = req_builder.header("X-Deno-Worker-Connection", value);
            } else {
                req_builder = req_builder.header(key, value);
            }
        }

        let req = match body {
            Some(body_content) => req_builder.body(
                Full::new(Bytes::from(body_content))
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                    .boxed(),
            )?,
            None => req_builder.body(
                Empty::<Bytes>::new()
                    .map_err(|e| Box::new(e) as Box<dyn std::error::Error + Send + Sync>)
                    .boxed(),
            )?,
        };

        let resp = self.client.request(req).await?;
        Ok(resp)
    }

    pub async fn json_request(
        &self,
        url: &str,
        method: Method,
        headers: HashMap<String, String>,
        body: Option<String>,
    ) -> Result<Value, DenoWorkerError> {
        let resp = self.request(url, method, headers, body).await?;
        let body = resp.collect().await?.to_bytes();
        let json: Value = serde_json::from_slice(&body)?;
        Ok(json)
    }

    pub fn terminate(&self) {
        let process = self.process.clone();
        let socket_path = self.socket_path.clone();
        let exit_sender = self.exit_sender.clone();

        tokio::spawn(async move {
            let mut child = process.lock().await.take();
            if let Some(ref mut child) = child {
                let _ = child.kill().await;
            }
            let _ = fs::remove_file(&socket_path).await;
            let _ = exit_sender.send((Some(9), "SIGKILL".to_string()));
        });
    }

    pub async fn shutdown(&self) {
        let process = self.process.clone();

        {
            let mut process_guard = process.lock().await;
            if let Some(child) = process_guard.as_mut() {
                // Send SIGINT for graceful shutdown
                #[cfg(unix)]
                {
                    let pid = child.id().unwrap();
                    unsafe {
                        libc::kill(pid as i32, libc::SIGINT);
                    }
                }

                #[cfg(not(unix))]
                {
                    let _ = child.kill().await;
                }
            }
        }
    }

    pub fn on_exit<F>(&self, callback: F)
    where
        F: Fn(Option<i32>, String) + Send + 'static,
    {
        let mut receiver = self.exit_sender.subscribe();
        tokio::spawn(async move {
            if let Ok((code, signal)) = receiver.recv().await {
                callback(code, signal);
            }
        });
    }
}

impl Drop for DenoHTTPWorker {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyper::Method;
    use std::collections::HashMap;

    #[tokio::test]
    async fn test_json_response() {
        let script = r#"
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      "#;

        let options = DenoWorkerOptions {
            print_output: true,
            ..Default::default()
        };

        let worker = DenoHTTPWorker::new(script, options).await.unwrap();

        let mut headers = HashMap::new();
        headers.insert("accept".to_string(), "application/json".to_string());

        let json = worker
            .json_request(
                "https://localhost/hello?isee=you",
                Method::GET,
                headers,
                None,
            )
            .await
            .unwrap();

        assert_eq!(json["ok"], "https://localhost/hello?isee=you");
        assert_eq!(json["headers"]["accept"], "application/json");

        worker.terminate();
    }

    #[tokio::test]
    async fn test_multiple_requests() {
        let script = r#"
        export default { async fetch (req: Request): Promise<Response> {
          let headers = {};
          for (let [key, value] of req.headers.entries()) {
            headers[key] = value;
          }
          return Response.json({ ok: req.url, headers: headers })
        } }
      "#;

        let options = DenoWorkerOptions {
            print_output: true,
            ..Default::default()
        };

        let worker = DenoHTTPWorker::new(script, options).await.unwrap();

        for _i in 0..10 {
            let mut headers = HashMap::new();
            headers.insert("accept".to_string(), "application/json".to_string());

            let json = worker
                .json_request(
                    "https://localhost/hello?isee=you",
                    Method::GET,
                    headers,
                    None,
                )
                .await
                .unwrap();

            assert_eq!(json["ok"], "https://localhost/hello?isee=you");
            assert_eq!(json["headers"]["accept"], "application/json");
        }

        worker.terminate();
    }

    #[tokio::test]
    async fn test_host_and_connection_headers() {
        // Create echo script that returns headers
        let script = r#"
        export default {
          async fetch(req: Request): Promise<Response> {
            const headers = {};
            for (const [key, value] of req.headers.entries()) {
              headers[key] = value;
            }
            return Response.json({
              url: req.url,
              headers: headers,
              body: await req.text(),
              method: req.method,
            });
          },
        };
      "#;

        let options = DenoWorkerOptions {
            print_output: true,
            ..Default::default()
        };

        let worker = DenoHTTPWorker::new(script, options).await.unwrap();

        let mut headers = HashMap::new();
        headers.insert("connection".to_string(), "happy".to_string());
        headers.insert("host".to_string(), "fish".to_string());

        let json = worker
            .json_request("https://localhost/", Method::GET, headers, None)
            .await
            .unwrap();

        assert_eq!(json["headers"]["connection"], "happy");
        assert_eq!(json["headers"]["host"], "fish");

        worker.terminate();
    }
}
