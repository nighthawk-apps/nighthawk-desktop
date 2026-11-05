import {
  DEFAULT_PUBLIC_CHANNELS,
  DEFAULT_SELECTED_CHANNEL,
} from "./chat-defaults.ts";

if (DEFAULT_SELECTED_CHANNEL !== "#nighthawk") {
  throw new Error("default selected channel must be #nighthawk");
}

if (DEFAULT_PUBLIC_CHANNELS[0] !== "#nighthawk") {
  throw new Error("autojoin must start with #nighthawk");
}

if (!DEFAULT_PUBLIC_CHANNELS.includes("#lunardao")) {
  throw new Error("upstream autojoin tail must still include #lunardao");
}
