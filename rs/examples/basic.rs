use deno_http_worker::{DenoHTTPWorker, DenoWorkerOptions};
use hyper::Method;
use std::collections::HashMap;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Create a simple Deno script that echoes request information
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

    // Create worker with options
    let options = DenoWorkerOptions {
        print_output: true,
        print_command_and_arguments: true,
        ..Default::default()
    };

    println!("Creating Deno HTTP worker...");
    let worker = DenoHTTPWorker::new(script, options).await?;

    // Make a simple request
    let mut headers = HashMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());

    println!("Making request...");
    let json = worker
        .json_request(
            "https://example.com/api/test",
            Method::POST,
            headers,
            Some("Hello from Rust!".to_string()),
        )
        .await?;

    println!("Response: {}", serde_json::to_string_pretty(&json)?);

    // Clean up
    worker.terminate();
    println!("Worker terminated");

    Ok(())
}