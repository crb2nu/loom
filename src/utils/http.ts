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
