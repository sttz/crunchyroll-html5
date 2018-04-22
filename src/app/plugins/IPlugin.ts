import { IPlayerApi } from "../media/player/IPlayerApi";
import { IMedia } from "crunchyroll-lib/models/IMedia";

export interface IPlugin {
  bootstrap(url: string, mediaId: number | undefined): void;
  load(media: IMedia, api: IPlayerApi): void;
  unload(): void;
}

export const IPluginSymbol = Symbol.for("IPlugin");