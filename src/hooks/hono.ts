import { SpanStatusCode, type Tracer, trace } from "@opentelemetry/api";
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from "@opentelemetry/semantic-conventions";
import type { Context, Handler, MiddlewareHandler, Next } from "hono";

export function patchHandler(tracer: Tracer, h: Handler | MiddlewareHandler) {
	return (c: Context, next: Next) => {
		const start = performance.now();
		let nextMwStart = start;
		let nextMwEnd = start;
		let nextCalled = false;

		const spanName = h.name || "anonymous";

		const s = trace.getActiveSpan();
		if (!s) {
			return h(c, next);
		}

		return tracer.startActiveSpan(spanName, async (span) => {
			try {
				const result = await h(c, async () => {
					nextCalled = true;
					nextMwStart = performance.now();
					const r = await next();
					nextMwEnd = performance.now();
					return r;
				});
				if (c.res && c.res.status >= 400) {
					span.setStatus({ code: SpanStatusCode.ERROR });
					span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, c.res.status);
				} else {
					span.setStatus({ code: SpanStatusCode.OK });
				}
				return result;
			} catch (error) {
				span.setStatus({ code: SpanStatusCode.ERROR });
				span.recordException(
					error instanceof Error ? error : new Error(String(error)),
				);
				throw error;
			} finally {
				const end = performance.now();
				span.setAttribute(
					"hono.middleware.duration_millis.pre",
					nextCalled ? nextMwStart - start : end - start,
				);
				span.setAttribute(
					"hono.middleware.duration_millis.post",
					nextCalled ? end - nextMwEnd : 0,
				);
				span.end();
			}
		});
	};
}
