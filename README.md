# comsync

[![GitHub license](https://img.shields.io/github/license/alexmojaki/comsync?style=flat)](https://github.com/alexmojaki/comsync/blob/master/LICENSE) [![Tests](https://github.com/alexmojaki/comsync/workflows/CI/badge.svg)](https://github.com/alexmojaki/comsync/actions)

[![NPM](https://nodei.co/npm/comsync.png)](https://npmjs.org/package/comsync)

A small library combining [`sync-message`](https://github.com/alexmojaki/sync-message) and [`comlink`](https://github.com/GoogleChromeLabs/comlink) to simplify synchronous communication between the main browser thread and web workers, and to better manage interrupting tasks running in the worker.

## Usage outline

First install the package `comsync` as well as the peer dependencies `comlink` and `sync-message`.

In the main thread:

```js
import {makeChannel} from "sync-message";
import {SyncClient} from "comsync";

// See sync-message for more info, other setup is required to make a channel.
const channel = makeChannel();

// First argument is a function that must return a new Worker object
const client = new SyncClient(() => new Worker("./my-worker.js"), channel);

// client.workerProxy is a Comlink proxy created by Comlink.wrap.
// This line is similar to `client.workerProxy.doStuff(arg1, arg2)`.
// Wrap callbacks in Comlink.proxy as usual.
const resultPromise = client.call(client.workerProxy.doStuff, arg1, arg2);

// When you know your worker is waiting with readMessage:
await client.writeMessage(message);

// When you need to stop the currently running task:
await client.interrupt();

// Get the final result:
let result;
try {
  result = await resultPromise;
} catch (e) {
  if (e.type === "InterruptError") {
    // The worker was terminated by client.interrupt()
    result = interruptedDefault;
  } else {
    throw e;
  }
}
```

In the worker:

```js
import * as Comlink from "comlink";
import {syncExpose} from "comsync";

// Expose classes and functions as usual with Comlink.
Comlink.expose({
  // Wrap individual functions with syncExpose.
  // This lets them receive an extra parameter 'syncExtras' at the beginning.
  // SyncClient.call sends through extra objects behind the scenes needed to construct syncExtras.
  // The remaining parameters after syncExtras are the arguments passed to SyncClient.call after the proxy method.
  doStuff: syncExpose((syncExtras, arg1, arg2) => {
    // syncExtras provides an improved interface for reading messages over raw sync-message.
    const message = syncExtras.readMessage();
  })
});
```

## `SyncClient`

### Constructor

The constructor takes two arguments:

1. A function that takes no arguments and returns a fresh [`Worker`](https://developer.mozilla.org/en-US/docs/Web/API/Worker) object.
2. Optionally, a `Channel` object (or null) as returned by `makeChannel` from `sync-message`. Alternatively, you can set `client.channel` later on.

It also accepts an optional type argument `T` which is passed to `Comlink.wrap<T>` to create the `workerProxy`.

### Properties

- `state`: one of `"idle" | "running" | "awaitingMessage"`. Starts out as `idle`. Set to `running` when the `call` method starts, and back to `idle` after it finishes. Set to `awaitingMessage` while the worker is calling `readMessage` and waiting for a call to `client.writeMessage` in the main thread, then back to `running` after the message is sent.
- `worker`: a running `Worker` returned by the function passed to the constructor.
- `workerProxy`: a Comlink proxy created by `Comlink.wrap<T>(this.worker)`.
- `interrupter`: an optional function you can set to use when calling `interrupt`. Has no arguments or return value.

### `call`

The first argument should be a Comlink proxy to a function/method/class exposed in the worker, accessed through `client.workerProxy`.
The remaining arguments are used to call the proxied function and are thus passed through to the exposed function in the worker.

Returns the value returned by the proxied function, which is necessarily a promise.

Throws (i.e. the promise is rejected with) an `InterruptError` if the worker is terminated by `client.interrupt` or `client.terminate` before the function completes.

Throws an error if another `call` is still running on this client, i.e. `client.state != "idle"`. This is because the channel should only be used by one reader and writer at a time.

Under the hood, two extra arguments are inserted at the beginning: `client.channel` and a low-level callback wrapped in a Comlink proxy.
In the worker, `syncExpose` returns a function which expects these extra arguments so it can be passed directly to `Comlink.expose`.
The extra arguments are then transformed into the first argument of type `SyncExtras` which you can use in your own function.

So the process looks like this:

```js
client.call(client.workerProxy.doStuff, arg1, arg2)
// =>
client.workerProxy.doStuff(client.channel, Comlink.proxy(callback), arg1, arg2)
// => in the worker: rawDoStuff is returned by syncExpose and passed to Comlink.expose
rawDoStuff(channel, callback, arg1, arg2)
// => here doStuff is the function written by you and passed to syncExpose
doStuff(syncExtras, arg1, arg2)
```

### `writeMessage`

Writes a message to the channel which will be received by a currently waiting call to `SyncExtras.readMessage` in the worker. The message can be any JSON serializable object. Uses `writeMessage` from `sync-message`.

Throws an error if `client.state != "awaitingMessage"`, so either check that yourself first or wait for a callback/`postMessage` from the worker, which should be sent before the call to `readMessage`.

### `interrupt`

Does nothing if `client.state == "idle"`, i.e. there's no `call` in progress. Otherwise, chooses the first available of three strategies  to interrupt the current `call`:

1. If the worker is currently hanging on `SyncExtras.readMessage` or `SyncExtras.syncSleep`, send a message causing that call to throw `InterruptError`. The worker is responsible for responding to the error appropriately.
2. Otherwise, if `client.interrupter` has a value, call it with no arguments. This is an optional user-defined function that can do anything. Note that the worker cannot receive messages while performing synchronous work, but it can check the value of a `SharedArrayBuffer`.
3. Otherwise, calls `client.worker.terminate()` to forcibly stop the worker thread. This doesn't necessarily mean that the worker will stop what it's doing immediately - that's up to the browser. The factory function passed to the constructor will immediately create a new `worker` and `workerProxy` so that future calls will have something to run on. The current `call` will throw an `InterruptError`, whereas the previous two strategies may allow the call to continue.

### `terminate`

Terminates the worker and destroys the proxy. Unlike `interrupt`, this doesn't start a new worker, and should only be used if you don't intend to use the client any more.

## `syncExpose`

Accepts a function and returns another function which should be passed to `Comlink.expose`, typically within another object or class.
The first argument passed to your input function will be of type `SyncExtras`, while the rest are the arguments passed to `SyncClient.call` in the main thread, see that section for more details. The return value of the input function will be returned to `SyncClient.call` wrapped in a `Promise`.

`SyncExtras` has a `channel` property which is the same as the channel on the client, in case you want to use it directly with `sync-message` functions, but usually you can call the methods on `SyncExtras` instead which deal with message IDs and interrupting for you.

These methods are synchronous, meaning they block the worker thread until they finish, rather than returning a promise or relying on callbacks. They throw `InterruptError` if `SyncClient.interrupt` is called while they're waiting.

If `channel` is null, then these methods throw `NoChannelError`. You can use this to indicate to users that they need to use a browser which supports `SharedArrayBuffer` or service workers so that `makeChannel` can return a functioning channel.

### `readMessage`

Returns a message sent by `SyncClient.writeMessage` on the main thread. Typically you need to first notify the main thread that you're about to wait for a message using `postMessage` or by calling a Comlink proxied callback, but you don't have to wait for a response for that part.

### `syncSleep`

Waits the given number of milliseconds.

## Errors

The library defines two errors `InterruptError` and `ChannelError`. To save you from relying on `instanceof` which may not always work with nested dependencies, they have a property `type` which is a string containing the name of the class.
