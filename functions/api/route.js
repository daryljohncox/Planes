import handler from "../../api/route.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
