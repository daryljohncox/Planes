import handler from "../../api/trace.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
