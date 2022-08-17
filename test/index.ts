import {
  asyncSleep,
  Channel,
  makeAtomicsChannel,
  makeServiceWorkerChannel,
  ServiceWorkerError,
  writeMessage,
} from "sync-message";
import {SyncClient} from "../lib";
import * as Comlink from "comlink";

const Worker = require("worker-loader!./worker").default;

async function runTests() {
  await navigator.serviceWorker.register("./sw.js");
  const serviceWorkerChannel = makeServiceWorkerChannel({timeout: 1000});
  try {
    await writeMessage(serviceWorkerChannel, "test", "foo");
  } catch (e) {
    if (e instanceof ServiceWorkerError) {
      window.location.reload();
    } else {
      throw e;
    }
  }

  const channels: Channel[] = [serviceWorkerChannel];
  const hasSAB = typeof SharedArrayBuffer !== "undefined";
  if (hasSAB) {
    channels.push(makeAtomicsChannel());
  }

  const client = new SyncClient(() => new Worker());
  const testResults: any[] = [];

  for (const channel of channels) {
    const channelType = channel.type;
    client.channel = channel;
    let resultPromise: Promise<any>;

    function runTask(...args: any[]) {
      resultPromise = client.call(client.workerProxy[test], ...args);
    }

    async function expect(expected: any) {
      const result = await resultPromise;
      const passed = expected === result;
      const testResult = {
        test,
        result,
        expected,
        passed,
        channelType,
      };
      console.log(JSON.stringify(testResult));
      testResults.push(testResult);
    }

    async function expectInterrupt() {
      try {
        await resultPromise;
      } catch (e) {
        resultPromise = e.type;
        await expect("InterruptError");
        return;
      }
      await expect("not failed");
    }

    let test = "testBasic";
    await client.interrupt(); // should do nothing because it's idle
    runTask(10);
    await expect(20);

    test = "testRead";
    runTask();
    await client.writeMessage(10);
    await expect(30);

    for (test of ["testReadInterrupt", "testInterruptSyncSleepExtras"]) {
      runTask();
      await asyncSleep(100);
      await client.interrupt();
      await client.writeMessage("message2");
      await expect("InterruptError message2");
    }

    for (test of [
      "testInterruptAsyncSleep",
      "testInterruptSyncSleepDirect",
      "testInterruptLoop",
    ]) {
      runTask();
      await client.interrupt();
      await expectInterrupt();
    }

    for (const ms of [500, 800]) {
      test = "testSleep";
      runTask(
        ms,
        Comlink.proxy(() => client.state),
      );
      resultPromise = resultPromise.then(
        ({slept, state}) =>
          state === "running" && slept > ms && slept < ms * 1.5,
      );
      await expect(true);
    }

    test = "testInterrupter";
    function getInterrupter(func: () => void) {
      client.interrupter = func;
    }
    runTask(Comlink.proxy(getInterrupter));
    await asyncSleep(100);
    await client.interrupt();
    await expect("successfully interrupted");
    delete client.interrupter;
  }

  (window as any).testResults = testResults;
  console.log(testResults);
  log(JSON.stringify(testResults));

  let numPassed = testResults.filter((t) => t.passed).length;
  let numTotal = testResults.length;
  let finalResult = numPassed === numTotal ? "PASSED" : "FAILED";
  body.innerHTML = `<h1 id=result>${numPassed} / ${numTotal} : ${finalResult}!</h1>` + body.innerHTML;
}

const body = document.getElementsByTagName("body")[0];
function log(text: string) {
  console.log(text);
  const elem = document.createElement("pre");
  elem.textContent = text;
  body.appendChild(elem);
}

runTests().catch(log);
