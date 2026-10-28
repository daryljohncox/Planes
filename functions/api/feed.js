import handler from "../../api/feed.js";
import { wrap } from "../../cf/shim.js";
export const onRequest = wrap(handler);
