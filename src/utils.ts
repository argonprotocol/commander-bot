import { JsonExt } from "@argonprotocol/mainchain";

export function onExit(fn: () => void | Promise<void>) {
  const handler = async () => {
    await fn();
    process.exit(0);
  };

  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
  process.once("exit", () => fn());
}

export function requireEnv<K extends keyof (typeof Bun)["env"]>(
  envVar: K
): string {
  if (!Bun.env[envVar]) throw new Error(`Bun.env.${envVar} is required`);
  return Bun.env[envVar] as any;
}

export function requireAll<T>(data: Partial<T>): T {
  for (const [key, value] of Object.entries(data)) {
    if (!value) throw new Error(`Required ${key}`);
  }
  return data as T;
}

export function jsonExt(data: any): Response {
  const json = JsonExt.stringify(data, 2);
  return new Response(json, {
    headers: { "Content-Type": "application/json" },
  });
}
