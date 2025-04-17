import { JsonExt } from '@argonprotocol/mainchain';

export function onExit(fn: () => void | Promise<void>) {
  const handler = async () => {
    await fn();
    process.exit(0);
  };

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  process.once("exit", () => fn());
}

export function jsonExt(data: any): Response {
  const json = JsonExt.stringify(data, 2);
  return new Response(json, {
    headers: { "Content-Type": "application/json" },
  });
}
