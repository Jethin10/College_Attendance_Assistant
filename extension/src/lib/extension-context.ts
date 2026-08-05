function readErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }

  return String(error ?? "");
}

/** Chrome invalidates existing content scripts whenever an extension is reloaded. */
export function isExtensionContextInvalidated(error: unknown) {
  return /extension context invalidated/i.test(readErrorMessage(error));
}
