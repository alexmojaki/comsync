/* eslint-disable */
// Otherwise webpack fails silently
// https://github.com/facebook/create-react-app/issues/8014

import {syncExpose} from "../lib";
import * as Comlink from "comlink";
import {asyncSleep, syncSleep} from "sync-message";

Comlink.expose({
  testBasic: syncExpose((extras, num) => {
    return num * 2;
  }),

  testRead: syncExpose((extras) => extras.readMessage() * 3),

  testReadInterrupt: syncExpose((extras) => {
    try {
      extras.readMessage();
      return "failed";
    } catch (e) {
      return e.type + " " + extras.readMessage();
    }
  }),

  testInterruptAsyncSleep: syncExpose(async () => {
    await asyncSleep(1000);
    return "failed";
  }),

  testInterruptSyncSleepDirect: syncExpose((extras) => {
    syncSleep(1000, extras.channel);
    return "failed";
  }),

  testInterruptLoop: syncExpose(() => {
    const start = performance.now();
    while (performance.now() - start < 1000) {}
    return "failed";
  }),

  testInterruptSyncSleepExtras: syncExpose((extras) => {
    try {
      extras.syncSleep(1000);
      return "failed";
    } catch (e) {
      return e.type + " " + extras.readMessage();
    }
  }),

  testSleep: syncExpose(
    async (extras, ms: number, getState: () => Promise<string>) => {
      const start = performance.now();
      extras.syncSleep(ms);
      const slept = performance.now() - start;
      await asyncSleep(100);
      return {slept, state: await getState()};
    },
  ),

  testInterrupter: syncExpose(async (extras, getInterrupter: any) => {
    await new Promise((resolve) => {
      return getInterrupter(Comlink.proxy(resolve));
    });
    return "successfully interrupted";
  }),
});
