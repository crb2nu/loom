import * as http from "http";
import * as https from "https";

import { DEFAULT_HTTP_TIMEOUT_MS } from "../constants";

/**
 * Make an HTTP GET request and parse the JSON response.
 *
 * @param targetUrl - The URL to request
 * @param headers - Optional HTTP headers
 * @param timeoutMs - Request timeout in milliseconds
 * @returns Parsed JSON response
 */
export function requestJson<T>(
  targetUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const httpModule = parsed.protocol === "https:" ? https : http;
    const request = httpModule.request(
      parsed,
      {
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const statusCode = response.statusCode ?? 500;
          if (statusCode >= 400) {
            const reason = body ? `${statusCode} ${body}` : `HTTP ${statusCode}`;
            reject(new Error(reason.trim()));
            return;
          }
          if (!body) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(body) as T);
          } catch (error) {
            reject(new Error(`Failed to parse hub response: ${(error as Error).message}`));
          }
        });
      }
    );

    request.on("error", (error) => reject(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Hub request timed out"));
    });
    request.end();
  });
}

/**
 * Make an HTTP GET request and return the raw text response.
 */
export function requestText(
  targetUrl: string,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const httpModule = parsed.protocol === "https:" ? https : http;
    const request = httpModule.request(
      parsed,
      {
        method: "GET",
        headers,
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          const statusCode = response.statusCode ?? 500;
          if (statusCode >= 400) {
            const reason = body ? `${statusCode} ${body}` : `HTTP ${statusCode}`;
            reject(new Error(reason.trim()));
            return;
          }
          resolve(body);
        });
      }
    );

    request.on("error", (error) => reject(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Hub request timed out"));
    });
    request.end();
  });
}

/**
 * Make an HTTP POST with a JSON body and parse the JSON response.
 * Used by mutation endpoints (slice 4). Body may be undefined for
 * fire-and-forget actions like pipeline pause/resume.
 */
export function postJson<T>(
  targetUrl: string,
  body: unknown,
  headers: Record<string, string> = {},
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS
): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    const payload = body === undefined ? "" : JSON.stringify(body);
    const httpModule = parsed.protocol === "https:" ? https : http;
    const request = httpModule.request(
      parsed,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
          ...headers,
        },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Buffer | string) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const respBody = Buffer.concat(chunks).toString("utf-8");
          const statusCode = response.statusCode ?? 500;
          if (statusCode >= 400) {
            const reason = respBody ? `${statusCode} ${respBody}` : `HTTP ${statusCode}`;
            reject(new Error(reason.trim()));
            return;
          }
          if (!respBody) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(respBody) as T);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${(error as Error).message}`));
          }
        });
      }
    );

    request.on("error", (error) => reject(error));
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("HTTP POST timed out"));
    });
    if (payload) {
      request.write(payload);
    }
    request.end();
  });
}
