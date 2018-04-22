import { Container, injectable, decorate } from "inversify";
import "reflect-metadata";
import { JsonStorage } from "../app/storage/JsonStorage";
import { IStorageSymbol, IStorage } from "../app/storage/IStorage";
import { IMechanism, IMechanismSymbol } from "../app/storage/mechanism/IMechanism";
import { LocalStorageMechanism } from "../app/storage/mechanism/LocalStorageMechanism";
import { IPlugin, IPluginSymbol } from "../app/plugins/IPlugin";
import { CrunchyrollTrackerPlugin } from "../app/plugins/CrunchyrollTrackerPlugin";

const container = new Container({
  autoBindInjectable: true
});

container.bind<IStorage>(IStorageSymbol).to(JsonStorage);

// -- Crunchyroll Tracker Plugin
container.bind<IPlugin>(IPluginSymbol).to(CrunchyrollTrackerPlugin).inSingletonScope();

export default container;