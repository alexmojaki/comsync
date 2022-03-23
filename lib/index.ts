import {Channel, readMessage, uuidv4, writeMessage} from "sync-message";
import * as Comlink from "comlink";

export class InterruptError extends Error {
  // To avoid having to use instanceof
  public readonly type = "InterruptError";
}

export class NoChannelError extends Error {
  // To avoid having to use instanceof
  public readonly type = "NoChannelError";
}

export class SyncClient<T> {
  public interrupter?: () => void;
  public state: "idle" | "running" | "awaitingMessage" = "idle";
  public worker: Worker;
  public workerProxy: any;

  private _interruptRejector?: (reason?: any) => void;
  private _interruptPromise?: Promise<void>;
  private _messageId = "";

  public constructor(
    public workerCreator: () => Worker,
    public channel?: Channel | null,
  ) {
    this._start();
  }

  public async interrupt() {
    if (this.state === "idle") {
      return;
    }

    if (this._messageId) {
      await this._writeMessage({interrupted: true});
      return;
    }

    if (this.interrupter) {
      await this.interrupter();
      return;
    }

    this.terminate();
    this._start();
  }

  public async call(proxyMethod: any, ...args: any[]) {
    if (this.state !== "idle") {
      throw new Error(`State is ${this.state}, not idle`);
    }

    let runningThisTask = true;
    this.state = "running";
    const th = this;
    const syncMessageCallback: SyncMessageCallback = (messageId, status) => {
      if (!runningThisTask || status === "init") {
        return;
      }

      th._messageId = messageId;
      if (status === "reading") {
        th.state = "awaitingMessage";
      } else if (status === "slept" && th._messageId === messageId) {
        th._messageId = "";
      }
    };

    this._interruptPromise = new Promise(
      (resolve, reject) => (this._interruptRejector = reject),
    );

    try {
      return await Promise.race([
        proxyMethod(this.channel, Comlink.proxy(syncMessageCallback), ...args),
        this._interruptPromise,
      ]);
    } finally {
      runningThisTask = false;
      this._reset();
    }
  }

  public async writeMessage(message: any) {
    if (this.state !== "awaitingMessage") {
      throw new Error("Not waiting for message");
    }
    await this._writeMessage({message});
  }

  public terminate() {
    this._interruptRejector?.(new InterruptError("Worker terminated"));
    this.workerProxy[Comlink.releaseProxy]();
    this.worker.terminate();
    delete this.workerProxy;
    delete this.worker;
  }

  private async _writeMessage(message: any) {
    const {_messageId} = this;
    if (!_messageId) {
      throw new Error("No messageId set");
    }
    this.state = "running";
    this._messageId = "";
    await writeMessage(this.channel, message, _messageId);
  }

  private _start() {
    this._reset();
    this.worker = this.workerCreator();
    this.workerProxy = Comlink.wrap<T>(this.worker);
  }

  private _reset() {
    this.state = "idle";
    this._messageId = "";
    delete this._interruptPromise;
    delete this._interruptRejector;
  }
}

export interface SyncExtras {
  channel: Channel | null;
  readMessage: () => any;
  syncSleep: (ms: number) => void;
}

type SyncMessageCallbackStatus = "init" | "reading" | "sleeping" | "slept";
type SyncMessageCallback = (
  messageId: string,
  status: SyncMessageCallbackStatus,
) => void;

export function syncExpose<T extends any[], R>(
  func: (extras: SyncExtras, ...args: T) => R,
) {
  return async function (
    channel: Channel | null,
    syncMessageCallback: SyncMessageCallback,
    ...args: T
  ): Promise<R> {
    await syncMessageCallback("", "init");
    function fullSyncMessageCallback(
      status: "reading" | "sleeping",
      options?: {timeout: number},
    ) {
      if (!channel) {
        throw new NoChannelError();
      }
      const messageId = uuidv4();
      syncMessageCallback(messageId, status);
      const response = readMessage(channel, messageId, options);
      if (response) {
        const {message, interrupted} = response;
        if (interrupted) {
          throw new InterruptError();
        }
        return message;
      } else if (status === "sleeping") {
        syncMessageCallback(messageId, "slept");
      }
    }

    const extras: SyncExtras = {
      channel,
      readMessage() {
        return fullSyncMessageCallback("reading");
      },
      syncSleep(ms: number) {
        if (!(ms > 0)) {
          return;
        }
        fullSyncMessageCallback("sleeping", {timeout: ms});
      },
    };
    return func(extras, ...args);
  };
}
