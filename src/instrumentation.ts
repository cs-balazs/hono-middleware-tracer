import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
	InstrumentationBase,
	type InstrumentationConfig,
	InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import { ATTR_HTTP_RESPONSE_STATUS_CODE } from "@opentelemetry/semantic-conventions";
import type { Context, Handler, MiddlewareHandler, Next } from "hono";
import type { ErrorHandler } from "hono/types";
import pkg from "../package.json" with { type: "json" };
import type {
	HonoApp,
	HonoMiddlewareTracerConfig,
	RouteArgs,
	UseArgs,
} from "./types.js";

const HONO_MODULE = "hono";
const HONO_SUPPORTED_VERSIONS = ["4.*"];

export class HonoMiddlewareTracer extends InstrumentationBase {
	private cfg: HonoMiddlewareTracerConfig = {
		fallbackSpanName: "anonymous",
	};

	constructor({
		fallbackSpanName,
		...config
	}: InstrumentationConfig & Partial<HonoMiddlewareTracerConfig> = {}) {
		super("hono-middleware-tracer", pkg.version, config);
		if (fallbackSpanName) {
			this.cfg.fallbackSpanName = fallbackSpanName;
		}
	}

	protected init() {
		const patchHandler = this.patchHandler.bind(this);
		const patchErrorHandler = this.patchErrorHandler.bind(this);

		return [
			new InstrumentationNodeModuleDefinition(
				HONO_MODULE,
				HONO_SUPPORTED_VERSIONS,
				(exports: { Hono?: new (...args: unknown[]) => HonoApp }) => {
					if (!exports.Hono) return exports;
					const h = exports.Hono as unknown as HonoApp;

					class InterceptedHono extends h {
						constructor(...args: ConstructorParameters<typeof h>) {
							super(...args);

							const originalGet = this.get.bind(this);
							const originalPost = this.post.bind(this);
							const originalPut = this.put.bind(this);
							const originalPatch = this.patch.bind(this);
							const originalDelete = this.delete.bind(this);
							const originalUse = this.use.bind(this);
							const originalOnError = this.onError.bind(this);

							function wrapFn<Fn extends typeof originalGet>(fn: Fn) {
								return ((...args: RouteArgs) => {
									const [path, ...handlers] = args;
									if (handlers.length <= 0) {
										return fn(...(args as any[]));
									}
									const newHandlers = handlers.map(patchHandler);
									return fn(path as any, ...newHandlers);
								}) as Fn;
							}

							const newUse = (...args: UseArgs) => {
								const newHandlers = args.map(patchHandler);
								return originalUse(...newHandlers);
							};

							const newOnError = (
								...params: Parameters<typeof this.onError>
							) => {
								const [handler] = params;
								return originalOnError(patchErrorHandler(handler));
							};

							this.get = wrapFn(originalGet);
							this.post = wrapFn(originalPost);
							this.put = wrapFn(originalPut);
							this.patch = wrapFn(originalPatch);
							this.delete = wrapFn(originalDelete);
							this.use = newUse;
							this.onError = newOnError;
						}
					}

					return new Proxy(exports, {
						get(target, prop, receiver) {
							if (prop === "Hono") return InterceptedHono;
							return Reflect.get(target, prop, receiver);
						},
					});
				},
				(moduleExports) => moduleExports,
			),
		];
	}

	private patchHandler(h: Handler | MiddlewareHandler) {
		return (c: Context, next: Next) => {
			const start = performance.now();
			let nextMwStart = start;
			let nextMwEnd = start;
			let nextCalled = false;

			const spanName = h.name || this.cfg.fallbackSpanName;

			// Don't produce parent traces. The library expects the usage of @hono/otel, so that should be the parent trace
			if (!trace.getActiveSpan()) {
				return h(c, next);
			}

			return this.tracer.startActiveSpan(spanName, async (span) => {
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

	private patchErrorHandler(h: ErrorHandler) {
		return (
			error: Parameters<ErrorHandler>[0],
			c: Parameters<ErrorHandler>[1],
		) => {
			const start = performance.now();

			const spanName = h.name || "errorHandler";

			// Don't produce parent traces. The library expects the usage of @hono/otel, so that should be the parent trace
			if (!trace.getActiveSpan()) {
				return h(error, c);
			}

			return this.tracer.startActiveSpan(spanName, async (span) => {
				try {
					const result = await h(error, c);

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
					span.setAttribute("hono.middleware.duration_millis.pre", end - start);
					span.setAttribute("hono.middleware.duration_millis.post", 0);
					span.end();
				}
			});
		};
	}
}
