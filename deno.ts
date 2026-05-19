import { handleRequest } from "./edge/wald.ts";

Deno.serve((request: Request) => handleRequest(request));
