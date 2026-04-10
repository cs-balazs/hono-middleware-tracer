import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { HonoInstrumentation } from "./instrumentation.js";

const honoInstrumentation = new HonoInstrumentation({});

const sdk = new NodeSDK({
	instrumentations: [...getNodeAutoInstrumentations(), honoInstrumentation],
});

sdk.start();

process.on("SIGTERM", () => {
	sdk
		.shutdown()
		.then(() => process.exit(0))
		.catch((err: unknown) => {
			console.error("[hono-middleware-tracer] SDK shutdown error:", err);
			process.exit(1);
		});
});

export { sdk, honoInstrumentation };
