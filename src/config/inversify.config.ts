import { Container, injectable, decorate } from "inversify";
import "reflect-metadata";
import { JsonStorage } from "../app/storage/JsonStorage";
import { IStorageSymbol, IStorage } from "../app/storage/IStorage";
import { IMechanism, IMechanismSymbol } from "../app/storage/mechanism/IMechanism";
import { LocalStorageMechanism } from "../app/storage/mechanism/LocalStorageMechanism";
import { IPlugin, IPluginSymbol } from "../app/plugins/IPlugin";
import TraktScrobblerPlugin, { ITraktOptions, ITraktOptionsSymbols } from '../app/plugins/TraktScrobblerPlugin';
import { CrunchyrollTrackerPlugin } from "../app/plugins/CrunchyrollTrackerPlugin";

const container = new Container({
  autoBindInjectable: true
});

container.bind<IStorage>(IStorageSymbol).to(JsonStorage);

// -- Trakt Plugin
container.bind<IPlugin>(IPluginSymbol).to(TraktScrobblerPlugin).inSingletonScope();

// Prod
container.bind<ITraktOptions>(ITraktOptionsSymbols).toConstantValue({
  client_id: '5ac1bf2ba188fc93f941eb0788ef5cb6e0e4bf96b882e914e6d0c17dacc8e7f2',
  client_secret: '3712241a1c467769e6c03336abb5fb9911f8665354d2aaffaa9f817e147a34ca'
});
// Staging
/*container.bind<ITraktOptions>(ITraktOptionsSymbols).toConstantValue({
  client_id: '68da48f1851b2a9743f6101c5d678ced48a0abe655a831cda4a1e4257f0036ea',
  client_secret: 'ed83870dad68e6f828b5a33d47bb0bafc135ae3a9a27d5b7dd784ad25165d12b',
  api_url: 'https://api-staging.trakt.tv'
});*/

// -- Crunchyroll Tracker Plugin
container.bind<IPlugin>(IPluginSymbol).to(CrunchyrollTrackerPlugin).inSingletonScope();

export default container;