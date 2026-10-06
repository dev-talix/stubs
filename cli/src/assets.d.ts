// Text assets bundled into the binary. `?raw` is how Vite (vitest) imports a file as text;
// esbuild strips the query and applies `--loader:.md=text`, so one specifier works in both.
declare module "*.md?raw" {
  const text: string;
  export default text;
}
