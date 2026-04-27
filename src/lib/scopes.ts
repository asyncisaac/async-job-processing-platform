export function hasScope(scopes: string[] | undefined, required: string) {
  return Array.isArray(scopes) && scopes.includes(required);
}

export function requireScope(scopes: string[] | undefined, required: string) {
  if (!hasScope(scopes, required)) {
    const err = new Error("forbidden");
    (err as unknown as { statusCode?: number }).statusCode = 403;
    throw err;
  }
}

