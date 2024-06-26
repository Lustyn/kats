# kats

Simple and durable subscription system for Krist using [NATS](https://nats.io/).

## Installation

The recommended installation method for kats is using [Docker](https://docs.docker.com/engine/install/). Example [nats-server.conf](./nats-server.conf) and [docker-compose.yml](./docker-compose.yml) files are provided to get you started.

```bash
git clone git@github.com:Lustyn/kats.git
cd kats
docker compose up -d
```

Alternatively, the Dockerfile and images available at `ghcr.io/lustyn/kats` can be used to run the container in any OCI-compliant runtime, like containerd in Kubernetes.

## Usage

All Krist transactions are reconciled (since the start of the chain) and stored into a JetStream called `krist`.
Subjects are formatted as `krist.from.<address>.to.<address>` and messages are the transaction object. Subjects can be used to filter to listen for events from a particular address, and consumers can opt to use different a [DeliveryPolicy](https://docs.nats.io/nats-concepts/jetstream/consumers#deliverpolicy) if they want to process all messages since the start of Krist or only new messages.

For example, in the JavaScript NATS client you can do the following:

```ts
const nc = nats.connect({
  servers: process.env.NATS_SERVER ?? "127.0.0.1",
  user: process.env.NATS_USER ?? "krist",
  pass: process.env.NATS_PASSWORD ?? "krist",
});

const jsm = nc.jetstreamManager();

await jsm.consumers.add("krist", {
  durable_name: "my-krist-consumer",
  deliver_policy: DeliverPolicy.New,
  ack_policy: AckPolicy.Explicit,
  replay_policy: ReplayPolicy.Instant,
  filter_subject: `krist.from.*.to.${process.env.KRIST_ADDRESS}`,
});

const kristConsumer = await js.consumers.get("krist", "my-krist-consumer");

const transactionMsgs = await kristConsumer.consume();
for await (const msg of transactionMsgs) {
  const transaction = msg.json<KristTransaction>();
  console.log("Processing transaction", transaction);
  msg.ack();
}
```
