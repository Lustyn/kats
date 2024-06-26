import { connect, JSONCodec } from "nats";
import { KristApi, type KristTransaction } from "krist";
import { createOrUpdateStream } from "./nats";
import PQueue from "p-queue";
import winston from "winston";

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple(),
  ),
  transports: [new winston.transports.Console()],
});

const host = process.env.NATS_HOST || "127.0.0.1";

const nats = await connect({ servers: host, user: "krist", pass: "krist" });

logger.info("Connected to NATS");

const jsm = await nats.jetstreamManager();

const kristTransactionSubject = (from: string, to: string) => `krist.from.${from}.to.${to}`;

// Create the stream if it doesn't exist
await createOrUpdateStream(jsm, {
  name: "krist",
  subjects: [
    kristTransactionSubject("*", "*"),
  ],
});

logger.info("Stream created");

const js = nats.jetstream();
const json = JSONCodec();

const kv = await js.views.kv("kats");

logger.info("KV view created");

const krist = new KristApi();

async function publishKristTransaction(transaction: KristTransaction) {
  const { id, to, from } = transaction;
  
  if (from === null || from === "") return;
  if (to === "name" || to === "a") return;

  logger.info(`Processing transaction ${id} from ${from} to ${to}`);

  await js.publish(kristTransactionSubject(from, to), json.encode(transaction), { msgID: id.toString() });
}

interface CatchupState {
  done: boolean;
  offset: number;
}

async function getCatchupState(): Promise<CatchupState> {
  const state = await kv.get("catchup_state");
  if (state === null) return { done: false, offset: 0 };
  return state.json<CatchupState>();
}

async function putCatchupState(state: CatchupState) {
  await kv.put("catchup_state", json.encode(state));
}

async function runCatchup() {
  const catchup = await getCatchupState();

  if (catchup.done) {
    logger.info("Already caught up");
    return;
  }

  let offset = catchup.offset;
  while (true) {
    const { count, total, transactions } = await krist.getTransactions({ limit: 1000, offset });
  
    logger.info(`Got ${count} transactions, ${total} total`);
  
    if (count === 0) {
      await putCatchupState({ done: true, offset });
      logger.info("Caught up");
      break;
    }
  
    for (const transaction of transactions) {
      await publishKristTransaction(transaction);
    }
    
    await putCatchupState({ done: false, offset: offset + count });
    await putLatestState({ lastSeen: transactions[transactions.length - 1].id });
    offset += count;
  }
}

interface LatestState {
  lastSeen: number;
}

async function getLatestState(): Promise<LatestState> {
  const state = await kv.get("latest_state");
  if (state === null) {
    const stream = await jsm.streams.get("krist");
    const last = await stream.getMessage({
      last_by_subj: kristTransactionSubject("*", "*"),
    });

    const transaction = last.json<KristTransaction>();

    return { lastSeen: transaction.id };
  }
  return state.json<LatestState>();
}

async function putLatestState(state: LatestState) {
  await kv.put("latest_state", json.encode(state));
}

async function runLatest() {
  const latest = await getLatestState();

  let offset = 0;
  let newTransactions: KristTransaction[] = [];
  last: while (true) {
    const { count, transactions } = await krist.getLatestTransactions({ limit: 10, offset });

    for (const transaction of transactions) {
      if (transaction.id <= latest.lastSeen) break last;
      logger.info(`Found new transaction ${transaction.id}`);
      newTransactions.push(transaction);
    }
    offset += count;
  }

  const transactions = newTransactions.toReversed();

  for (const transaction of transactions) {
    await publishKristTransaction(transaction);
  }

  if (transactions.length > 0) {
    logger.info(`Processed latest transactions, ${transactions.length} new transactions`);
    await putLatestState({ lastSeen: transactions[transactions.length - 1].id });
  }
}

async function exit(code?: number) {
  await nats.close();
  process.exit(code);
}

const latestQueue = new PQueue({ concurrency: 1 });
async function tryQueueLatest() {
  if (latestQueue.size > 1) return;

  try {
    await latestQueue.add(runLatest)
  } catch (e) {
    console.error("Error in latest", e);
  }
}

async function main() {
  await runCatchup();

  (function go() {
    tryQueueLatest()
      .finally(() => {
        setTimeout(go, 1000);
      });
  })();

  const ws = krist.createWsClient({
    initialSubscriptions: ["transactions"],
  });

  ws.on("transaction", async transaction => {
    logger.info("New transaction received:", transaction.transaction.id);
    await tryQueueLatest();
  });

  ws.on("wsClose", () => {
    logger.info("Krist websocket closed");
  });

  ws.on("wsError", e => {
    logger.error("Krist websocket error", e);
  });

  ws.on("wsOpen", () => {
    logger.info("Connected to Krist");
  });

  await ws.connect();
}

main()
  .catch(e => {
    console.error(e);
    return exit(1);
  });
