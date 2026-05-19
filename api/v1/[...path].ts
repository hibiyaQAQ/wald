import { handleRequest } from "../../../edge/wald";

export const config = {
  runtime: "edge",
};

export default function handler(request: Request): Promise<Response> {
  return handleRequest(request);
}
