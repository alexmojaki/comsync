import {Channel, readMessage, uuidv4, writeMessage} from "sync-message";
import * as Comlink from 'comlink';

export class InterruptError extends Error {
  // To avoid having to use instanceof
  public readonly type = "InterruptError";
}

export class NoChannelError extends Error {
  // To avoid having to use instanceof
  public readonly type = "NoChannelError";
}

export class TaskClient<T> {
  public interrupter?: () => void;
  public state: "idle" | "running" | "awaitingMessage" = "idle";
  public worker: Worker;
  public workerProxy: any;
  public interruptRejector?: (reason?: any) => void;

  private _interruptPromise?: Promise<void>;
  private _messageId = "";

  public constructor(public workerCreator: () => Worker, public channel?: Channel) {
    this._start();
  }

  public async interrupt(force?: boolean) {
    if (this.state === "idle") {
      return;
    }

    if (!force) {
      if (this._messageId) {
        await this._writeMessage({interrupted: true});
        return;
      }

      if (this.interrupter) {
        await this.interrupter();
        return;
      }
    }

    this.terminate();
    this._start();
  }

  public async runTask(proxyMethod: any, ...args: any[]) {
    if (this.state !== "idle") {
      throw new Error("Still running a task");
    }
    this.state = "running";
    const th = this;
    const syncMessageCallback: SyncMessageCallback = (messageId, status) => {
      th._messageId = messageId;
      if (status === "reading") {
        th.state = "awaitingMessage";
      } else if (status === "slept" && th._messageId === messageId) {
        th._messageId = "";
      }
    };

    this._interruptPromise = new Promise((resolve, reject) => this.interruptRejector = reject);

    try {
      return await Promise.race([
        proxyMethod(
          this.channel,
          Comlink.proxy(syncMessageCallback),
          ...args,
        ),
        this._interruptPromise,
      ]);
    } finally {
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
    this.interruptRejector?.(new InterruptError("Worker terminated"));
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
    this.workerProxy = Comlink.wrap(this.worker);
  }

  private _reset() {
    this.state = "idle";
    this._messageId = "";
    delete this._interruptPromise;
    delete this.interruptRejector;
  }
}

export interface ExposeSyncExtras {
  channel: Channel | null;
  readMessage: () => any;
  syncSleep: (ms: number) => void;
}

type SyncMessageCallbackStatus = "reading" | "sleeping" | "slept";
type SyncMessageCallback = (messageId: string, status: SyncMessageCallbackStatus) => void;

export function exposeSync<T extends any[]>(func: (extras: ExposeSyncExtras, ...args: T) => any) {
  return function (
    channel: Channel | null,
    syncMessageCallback: SyncMessageCallback,
    ...args: T
  ) {
    function fullSyncMessageCallback(status: "reading" | "sleeping", options?: { timeout: number }) {
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

    const extras: ExposeSyncExtras = {
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
  }
}
