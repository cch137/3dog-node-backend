export const stringifyError = (e: unknown) => {
  if (e instanceof Error) {
    return e.message;
  }
  if (
    e &&
    typeof e === "object" &&
    "error" in e &&
    typeof e.error === "string"
  ) {
    return e.error;
  }
  return `Error: ${String(e)}`;
};
