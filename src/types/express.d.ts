import "express-serve-static-core";

declare module "express-serve-static-core" {
  interface Request {
    tenantId?: string;
    apiKey?: string;
    apiKeyId?: string;
    apiKeyScopes?: string[];
  }
}

