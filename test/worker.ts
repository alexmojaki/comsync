/* eslint-disable */
// Otherwise webpack fails silently
// https://github.com/facebook/create-react-app/issues/8014

import {exposeSync} from "../lib";
import * as Comlink from "comlink";
import {asyncSleep, syncSleep} from "sync-message";


Comlink.expose({
  testBasic: exposeSync((extras, num) => {
    return num * 2;
  }),

  testRead: exposeSync((extras) => extras.readMessage() * 3),

  testReadInterrupt: exposeSync((extras) => {
    try {
      extras.readMessage();
      return "failed";
    } catch (e) {
      return e.type + " " + extras.readMessage();
    }
  }),

  testInterruptAsyncSleep: exposeSync(async () => {
    await asyncSleep(1000);
    return "failed";
  }),

  testInterruptSyncSleepDirect: exposeSync((extras) => {
    syncSleep(1000, extras.channel);
    return "failed";
  }),

  testInterruptLoop: exposeSync(() => {
    const start = performance.now();
    while (performance.now() - start < 1000) {
    }
    return "failed";
  }),

  testInterruptSyncSleepExtras: exposeSync((extras) => {
    try {
      extras.syncSleep(1000);
      return "failed";
    } catch (e) {
      return e.type + " " + extras.readMessage();
    }
  }),

  testSleep: exposeSync(async (extras, ms: number, getMessageId: () => Promise<string>) => {
    const start = performance.now();
    extras.syncSleep(ms);
    const slept = performance.now() - start;
    await asyncSleep(100);
    return {slept, messageId: await getMessageId()};
  }),

  testInterrupter: exposeSync(async (extras, getInterrupter: any) => {
    await new Promise((resolve) => {
      return getInterrupter(Comlink.proxy(resolve));
    });
    return "successfully interrupted";
  }),
});
