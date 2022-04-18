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

export class SyncClient<T = any> {
  public interrupter?: () => void;
  public state: "idle" | "running" | "awaitingMessage" | "sleeping" = "idle";
  public worker: Worker;
  public workerProxy: Comlink.Remote<T>;

  private _interruptRejector?: (reason?: any) => void;
  private _interruptPromise?: Promise<void>;

  private _messageIdBase = "";
  private _messageIdSeq = 0;

  private _awaitingMessageResolve?: () => void;

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

    if (this.state === "awaitingMessage" || this.state === "sleeping") {
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

    this._messageIdBase = uuidv4();
    this._messageIdSeq = 0;

    const syncMessageCallback: SyncMessageCallback = (status) => {
      if (!runningThisTask || status === "init") {
        return;
      }

      if (status === "reading") {
        this.state = "awaitingMessage";
        this._messageIdSeq++;
        this._awaitingMessageResolve?.();
      } else if (status === "sleeping") {
        this.state = "sleeping";
        this._messageIdSeq++;
      } else if (status === "slept") {
        this.state = "running";
      }
    };

    this._interruptPromise = new Promise(
      (resolve, reject) => (this._interruptRejector = reject),
    );

    try {
      return await Promise.race([
        proxyMethod(
          this.channel,
          Comlink.proxy(syncMessageCallback),
          this._messageIdBase,
          ...args,
        ),
        this._interruptPromise,
      ]);
    } finally {
      runningThisTask = false;
      this._reset();
    }
  }

  public async writeMessage(message: any) {
    if (this.state === "idle" || !this._messageIdBase) {
      throw new Error("No active call to send a message to.");
    }

    if (this.state !== "awaitingMessage") {
      if (this._awaitingMessageResolve) {
        throw new Error(
          "Not waiting for message, and another write is already queued.",
        );
      }

      await new Promise<void>((resolve) => {
        this._awaitingMessageResolve = resolve;
      });
      delete this._awaitingMessageResolve;
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
    this.state = "running";
    const messageId = makeMessageId(this._messageIdBase, this._messageIdSeq);
    await writeMessage(this.channel, message, messageId);
  }

  private _start() {
    this._reset();
    this.worker = this.workerCreator();
    this.workerProxy = Comlink.wrap<T>(this.worker);
  }

  private _reset() {
    this.state = "idle";
    delete this._interruptPromise;
    delete this._interruptRejector;
    delete this._awaitingMessageResolve;
    delete this._messageIdBase;
  }
}

export interface SyncExtras {
  channel: Channel | null;
  readMessage: () => any;
  syncSleep: (ms: number) => void;
}

type SyncMessageCallbackStatus = "init" | "reading" | "sleeping" | "slept";
type SyncMessageCallback = (status: SyncMessageCallbackStatus) => void;

export function syncExpose<T extends any[], R>(
  func: (extras: SyncExtras, ...args: T) => R,
) {
  return async function (
    channel: Channel | null,
    syncMessageCallback: SyncMessageCallback,
    messageIdBase: string,
    ...args: T
  ): Promise<R> {
    await syncMessageCallback("init");
    let messageIdSeq = 0;

    function fullSyncMessageCallback(
      status: "reading" | "sleeping",
      options?: {timeout: number},
    ) {
      if (!channel) {
        throw new NoChannelError();
      }
      syncMessageCallback(status);
      const messageId = makeMessageId(messageIdBase, ++messageIdSeq);
      const response = readMessage(channel, messageId, options);
      if (response) {
        const {message, interrupted} = response;
        if (interrupted) {
          throw new InterruptError();
        }
        return message;
      } else if (status === "sleeping") {
        syncMessageCallback("slept");
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

function makeMessageId(base: string, seq: number) {
  return `${base}-${seq}`;
}
