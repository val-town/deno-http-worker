import type { Readable } from 'node:stream';
import type { Dispatcher, FormData } from 'undici'

export type RequestOptions = { // partially derived from undici.Dispatcher.RequestOptions
    url: string;
    method: Dispatcher.HttpMethod;
    /** 
     * @default null 
     * */
    body?: string | Buffer | Uint8Array | Readable | null | FormData;
    /**
     * Headers to be sent with the request.
     * 
     * @default new Headers()
     */
    headers?: Headers;
}

export type ResponseData = { // partially derived from undici.Dispatcher.ResponseData
    statusCode: number;
    headers: Dispatcher.ResponseData['headers'];
    body:  Dispatcher.ResponseData['body'];
    trailers: Record<string, string>;
    context: object;
}