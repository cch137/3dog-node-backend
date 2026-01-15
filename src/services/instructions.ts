import path from "path";
import { readFileSync } from "fs";
import { readFile } from "fs/promises";
import Handlebars from "handlebars";

const getTemplatesDirname = () =>
  path.resolve(__dirname, "../assets/instructions/");

export async function loadInstructionsTemplate<T = {}>(name: string) {
  const filePath = path.resolve(getTemplatesDirname(), `${name}.md`);
  const md = await readFile(filePath, "utf8");
  return Handlebars.compile<T>(md);
}

export function loadInstructionsTemplateSync<T = {}>(name: string) {
  const filePath = path.resolve(getTemplatesDirname(), `${name}.md`);
  const md = readFileSync(filePath, "utf8");
  return Handlebars.compile<T>(md);
}
