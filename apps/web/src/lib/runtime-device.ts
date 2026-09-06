export type LocalModelDevice = "webgpu" | "wasm";

export function selectLocalModelDevice(webGpuAvailable: boolean): LocalModelDevice {
  return webGpuAvailable ? "webgpu" : "wasm";
}

export function browserHasWebGpu(runtimeNavigator: unknown = typeof navigator !== "undefined" ? navigator : undefined): boolean {
  return Boolean(runtimeNavigator && typeof runtimeNavigator === "object" && "gpu" in runtimeNavigator);
}
