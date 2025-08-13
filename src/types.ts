import type { Readable } from 'node:stream';
import type { Dispatcher, FormData } from 'undici'
import type { IncomingHttpHeaders } from 'undici/types/header.js';
import type BodyReadable from 'undici/types/readable.js';

export type RequestOptions = { // partially derived from undici.Dispatcher.RequestOptions
    origin?: string | URL;
    path: string;
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
    /**
     * Query string params to be embedded in the request URL.
     * 
     * @default null
     */
    query?: Record<string, any>;
}

export type ResponseData = { // partially derived from undici.Dispatcher.ResponseData
    statusCode: number;
    headers: IncomingHttpHeaders;
    body: BodyReadable.default;
    trailers: Record<string, string>;
    context: object;
}