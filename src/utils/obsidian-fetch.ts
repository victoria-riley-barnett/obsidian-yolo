import { requestUrl, RequestUrlParam, RequestUrlResponse } from 'obsidian'

/**
 * A fetch-compatible wrapper around Obsidian's requestUrl that bypasses CORS restrictions.
 * This is necessary because Obsidian plugins run in the app:// origin which triggers CORS
 * errors when making requests to external APIs like api.deepseek.com.
 *
 * Obsidian's requestUrl uses Node.js HTTP under the hood, which is exempt from CORS.
 *
 * IMPORTANT: This wrapper does NOT support true streaming responses - the full response
 * is fetched at once and then returned.
 */
export async function obsidianFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === 'string' ? input : input.toString()

  const headers: Record<string, string> = {}
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value
      })
    } else {
      Object.assign(headers, init.headers)
    }
  }

  // Convert body to string if needed - requestUrl only accepts string or ArrayBuffer
  let body: string | ArrayBuffer | undefined
  if (init?.body) {
    if (typeof init.body === 'string') {
      body = init.body
    } else if (init.body instanceof ArrayBuffer) {
      body = init.body
    } else if (init.body instanceof Uint8Array) {
      body = init.body.buffer as ArrayBuffer
    } else if (typeof init.body === 'object') {
      // Likely a plain object or something that needs JSON serialization
      body = JSON.stringify(init.body)
    } else {
      // Try converting to string as fallback
      body = String(init.body)
    }
  }

  // Remove content-length header as requestUrl will set it automatically
  // and mismatched content-length can cause issues
  delete headers['content-length']
  delete headers['Content-Length']

  const requestParams: RequestUrlParam = {
    url,
    method: init?.method || 'GET',
    headers,
    body,
    throw: false, // Don't throw on non-2xx responses, let us handle them
  }

  const response: RequestUrlResponse = await requestUrl(requestParams)

  // Convert Obsidian's response format to a fetch-compatible Response object
  const responseHeaders = new Headers()
  if (response.headers) {
    Object.entries(response.headers).forEach(([key, value]) => {
      responseHeaders.set(key, value)
    })
  }

  // Create a Response-like object
  return new Response(
    response.text ? response.text : JSON.stringify(response.json),
    {
      status: response.status,
      statusText: getStatusText(response.status),
      headers: responseHeaders,
    },
  )
}

/**
 * Get HTTP status text for a status code
 */
function getStatusText(status: number): string {
  const statusTexts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  }
  return statusTexts[status] || 'Unknown'
}

/**
 * Creates a streaming fetch using Node.js https module which bypasses CORS.
 * This provides true streaming support for SSE responses.
 * Available in Obsidian because it runs on Electron with Node.js integration.
 */
async function nodeStreamingFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const urlString = typeof input === 'string' ? input : input.toString()
  const parsedUrl = new URL(urlString)
  
  // Dynamic import of Node.js https module
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const https = (window as any).require?.('https')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const http = (window as any).require?.('http')
  
  const httpModule = parsedUrl.protocol === 'https:' ? https : http
  
  console.log('[YOLO DeepSeek] Attempting streaming fetch, https available:', !!https, 'http available:', !!http)
  
  if (!httpModule) {
    // Fallback to non-streaming if Node modules are not available
    console.warn('[YOLO DeepSeek] Node.js http/https modules not available, falling back to non-streaming')
    return obsidianFetch(input, init)
  }
  
  console.log('[YOLO DeepSeek] Using Node.js streaming for', parsedUrl.hostname)

  // Build headers
  const headers: Record<string, string> = {}
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value
      })
    } else if (Array.isArray(init.headers)) {
      init.headers.forEach(([key, value]) => {
        headers[key] = value
      })
    } else {
      Object.assign(headers, init.headers)
    }
  }
  
  // Remove content-length as it will be set automatically
  delete headers['content-length']
  delete headers['Content-Length']

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: init?.method || 'GET',
      headers,
    }

    const req = httpModule.request(options, (res: {
      statusCode: number
      headers: Record<string, string | string[]>
      on: (event: string, cb: (...args: unknown[]) => void) => void
    }) => {
      const responseHeaders = new Headers()
      Object.entries(res.headers).forEach(([key, value]) => {
        if (Array.isArray(value)) {
          value.forEach(v => responseHeaders.append(key, v))
        } else if (value) {
          responseHeaders.set(key, value)
        }
      })

      console.log('[YOLO DeepSeek] Response received, status:', res.statusCode)

      // Create a ReadableStream that receives chunks as they arrive
      let chunkCount = 0
      const stream = new ReadableStream({
        start(controller) {
          res.on('data', (chunk: unknown) => {
            chunkCount++
            if (chunkCount <= 5) {
              console.log('[YOLO DeepSeek] Chunk #' + chunkCount + ' received, size:', 
                chunk instanceof Buffer ? chunk.length : typeof chunk === 'string' ? chunk.length : 'unknown')
            }
            if (chunk instanceof Buffer || chunk instanceof Uint8Array) {
              controller.enqueue(new Uint8Array(chunk))
            } else if (typeof chunk === 'string') {
              controller.enqueue(new TextEncoder().encode(chunk))
            }
          })
          res.on('end', () => {
            console.log('[YOLO DeepSeek] Stream ended, total chunks:', chunkCount)
            controller.close()
          })
          res.on('error', (error: unknown) => {
            controller.error(error)
          })
        }
      })

      resolve(new Response(stream, {
        status: res.statusCode,
        statusText: getStatusText(res.statusCode),
        headers: responseHeaders,
      }))
    })

    req.on('error', (error: Error) => {
      reject(error)
    })

    // Send body if present
    if (init?.body) {
      if (typeof init.body === 'string') {
        req.write(init.body)
      } else if (init.body instanceof ArrayBuffer) {
        req.write(Buffer.from(init.body))
      } else if (init.body instanceof Uint8Array) {
        req.write(Buffer.from(init.body))
      }
    }

    req.end()
  })
}

/**
 * Creates a fetch function for use with the OpenAI SDK that bypasses CORS.
 * Uses Electron's net module for streaming requests (supports true SSE streaming),
 * and falls back to Obsidian's requestUrl for non-streaming.
 *
 * Usage with OpenAI SDK:
 * ```
 * const client = new OpenAI({
 *   apiKey: 'your-key',
 *   baseURL: 'https://api.deepseek.com',
 *   fetch: createObsidianFetch(),
 *   dangerouslyAllowBrowser: true,
 * })
 * ```
 */
export function createObsidianFetch(): typeof fetch {
  return async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    // Check if this is a streaming request
    const isStreaming =
      init?.body &&
      typeof init.body === 'string' &&
      init.body.includes('"stream":true')

    if (isStreaming) {
      // Try to use Node.js https module for true streaming
      try {
        return await nodeStreamingFetch(input, init)
      } catch (error) {
        console.warn('Node streaming fetch failed, falling back to non-streaming:', error)
        return obsidianFetch(input, init)
      }
    }

    // Use Obsidian's requestUrl for non-streaming requests
    return obsidianFetch(input, init)
  }
}
