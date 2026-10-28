import handler from "../../api/iss.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
