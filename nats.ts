import { NatsError, type JetStreamManager, type StreamConfig } from "nats";

export async function createOrUpdateStream(jsm: JetStreamManager, config: Partial<StreamConfig> & { name: string }) {
  try {
    return await jsm.streams.add(config);
  } catch (e) {
    if (e instanceof NatsError && e.jsError()?.err_code === 10058) {
      return await jsm.streams.update(config.name, config);
    }
    throw e;
  }
}