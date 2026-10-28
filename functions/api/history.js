import handler from "../../api/history.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
