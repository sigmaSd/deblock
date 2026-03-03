// Arrow functions assigned to variables — tests that blocking propagates
// through const/let arrow functions, not just function declarations.

const loadFile = () => Deno.readTextFileSync("data.txt");

const transform = (s: string) => s.toUpperCase();

const processData = () => {
  return transform(loadFile());
};

export const handler = async () => {
  await Promise.resolve();
  processData();
};
