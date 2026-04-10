import type { Handler, MiddlewareHandler } from "hono";

export type HonoApp = typeof import("hono")["Hono"];

export type RouteArgs = [
	path: string,
	...handlers: (Handler | MiddlewareHandler)[],
];

export type UseArgs = (Handler | MiddlewareHandler)[];
