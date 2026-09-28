import type { Request, Response, NextFunction } from 'express'
import { config } from '../config'

/**
 * An error with an intended HTTP status. Throw this from a route to control the
 * response code without hand-rolling a res.status(...).json(...) in every branch.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

/**
 * JSON 404 for unmatched routes.
 *
 * Express's default sends an HTML page. Every consumer of this server — the React
 * admin UI, the Chrome extension, Slack's interactivity callbacks — parses JSON, so
 * a typo'd path surfaced as "Unexpected token '<' in JSON at position 0", which says
 * nothing about the actual mistake.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: 'Not found',
    detail: `No route matches ${req.method} ${req.path}`,
  })
}

/**
 * Terminal error middleware.
 *
 * Express only treats a FOUR-argument function as an error handler. Dropping `next`
 * from the signature does not fail loudly — it silently demotes this to an ordinary
 * middleware that never runs on errors at all.
 *
 * Without this, an async route that throws returns Express's default HTML stack trace:
 * wrong content type for every caller, and it leaks file paths and line numbers to
 * anyone who can reach the endpoint. Stacks go to the logs; the response carries only
 * the message, and only in development.
 */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  // express.json() rejects a malformed body with a SyntaxError carrying its own
  // `status`. Left alone that reports as a 500 and sends us hunting for a server bug
  // that is really a caller sending bad JSON.
  const isBodyParseError = err instanceof SyntaxError && 'body' in err

  const status = err instanceof HttpError ? err.status : isBodyParseError ? 400 : 500
  const message = isBodyParseError
    ? `Malformed JSON in request body: ${(err as SyntaxError).message}`
    : err instanceof Error
      ? err.message
      : String(err)

  // 5xx is our bug and always worth a stack. 4xx is the caller's and would be noise.
  if (status >= 500) {
    console.error(`[API] ${req.method} ${req.path} failed:`, err)
  } else {
    console.warn(`[API] ${req.method} ${req.path} -> ${status}: ${message}`)
  }

  // Headers already flushed — a streamed CSV export that failed midway, say. Anything
  // written now would corrupt the body, so hand back to Express to destroy the socket.
  if (res.headersSent) {
    next(err)
    return
  }

  const isProd = config.NODE_ENV === 'production'
  res.status(status).json({
    // A 500's message is an internal detail and can carry connection strings or row
    // data. Deliberate HttpErrors are written to be read, so those pass through.
    error: status >= 500 && isProd ? 'Internal server error' : message,
    ...(err instanceof HttpError && err.detail !== undefined ? { detail: err.detail } : {}),
    ...(isProd ? {} : { stack: err instanceof Error ? err.stack : undefined }),
  })
}

/**
 * Wraps an async route so a rejected promise reaches errorHandler.
 *
 * Express 4 does not await handlers: a promise rejection in an async route is an
 * unhandled rejection, not a request error, so the client gets no response at all and
 * hangs until it times out. That is the exact failure mode that made the account scan
 * look like it was "just loading" — nothing ever answered.
 */
export function asyncRoute<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: T, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next)
  }
}
