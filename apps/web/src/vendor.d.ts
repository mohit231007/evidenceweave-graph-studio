declare module "mammoth/mammoth.browser" {
  export interface ConversionResult { value: string; messages: unknown[] }
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConversionResult>;
}
