# relay-linear-publish-queue

Publish changes in the order they're received

## Installation

`yarn add relay-linear-publish-queue`

## Why

- By default, Relay publishes changes in an arbitrary order, making local and optimistic updates unpredictable based on latency.
- By default, Relay double normalizes every optimistic update & reconstructs the state tree more often than necessary
- For more info, read the blog post: [https://dev.to/mattkrick/distributed-state-101-why-i-forked-facebook-s-relay-1p7d](https://dev.to/mattkrick/distributed-state-101-why-i-forked-facebook-s-relay-1p7d)

## High level architecture

- Updates (local, optimistic, or server) get put into a queue
- Updates get processed in that order
- When a server update returns, it's provided the same state as it's optimistic counterpart. This is standard for distributed systems. Otherwise, state is a function of latency, which causes divergence. 

## Usage
```js
import defaultGetDataID from 'relay-runtime/lib/defaultGetDataID'
import LinearPublishQueue from 'relay-linear-publish-queue'
const publishQueue = new LinearPublishQueue(store, handlerProvider, defaultGetDataID)
new Environment({store, handlerProvider, network, publishQueue})
```

Also requires installing my fork. See package.json for the hash

## License

MIT
