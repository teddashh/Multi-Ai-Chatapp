// Minimal ambient declaration — opencc-js ships no types but we only
// use one entry point (Converter). Keep it narrow on purpose so a
// future API change forces a re-check rather than silently any-typing.
declare module 'opencc-js' {
  export type ConverterLocale =
    | 'cn' | 'tw' | 'twp' | 'hk' | 'jp' | 't';
  export interface ConverterOptions {
    from: ConverterLocale;
    to: ConverterLocale;
  }
  export function Converter(opts: ConverterOptions): (text: string) => string;
}
