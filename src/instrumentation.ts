import {
	InstrumentationBase,
	type InstrumentationConfig,
	InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import type { Handler, MiddlewareHandler } from "hono";
import pkg from "../package.json" with { type: "json" };
import { patchHandler } from "./hooks/hono.js";

const HONO_MODULE = "hono";
const HONO_SUPPORTED_VERSIONS = ["4.*"];

type HonoApp = typeof import("hono")["Hono"];
type RouteArgs = [path: string, ...handlers: (Handler | MiddlewareHandler)[]];
type UseArgs = (Handler | MiddlewareHandler)[];

export class HonoInstrumentation extends InstrumentationBase {
	constructor(config: InstrumentationConfig = {}) {
		super("hono-middleware-tracer", pkg.version, config);
	}

	protected init() {
		const tracer = this.tracer;
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
							const originalDelete = this.delete.bind(this);
							const originalUse = this.use.bind(this);

							function wrapFn<Fn extends typeof originalGet>(fn: Fn) {
								return ((...args: RouteArgs) => {
									const [path, ...handlers] = args;
									if (handlers.length <= 0) {
										return fn(...(args as any[]));
									}
									const newHandlers = handlers.map((h) =>
										patchHandler(tracer, h),
									);
									return fn(path as any, ...newHandlers);
								}) as Fn;
							}

							const newUse = (...args: UseArgs) => {
								const newHandlers = args.map((h) => patchHandler(tracer, h));
								return originalUse(...newHandlers);
							};

							this.get = wrapFn(originalGet);
							this.post = wrapFn(originalPost);
							this.put = wrapFn(originalPut);
							this.delete = wrapFn(originalDelete);
							this.use = newUse;
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
}
