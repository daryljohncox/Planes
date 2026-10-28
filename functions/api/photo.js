import handler from "../../api/photo.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
