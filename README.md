# Hashswap Zilliqa Javascript SDK

## Setup

Install from npm:

`npm install hashswap-zilliqa-js-sdk`

## SDK Usage

Initialize the sdk based on the required network, then call the required methods which will automatically map and call the corresponding smart contract correct transitions.

```ts
  import { Hex } from 'hashswap-zilliqa-js-sdk'

  (async () => {
    const hex = new Hex(Network.TestNet)
    await hex.initialize()
    await hex.addLiquidity('KIMT', '42', '42')
    await hex.teardown()
  })()
```

### Methods

All public methods for Hashswap decentralized exchange are found in `Hex` SDK object 

All public methods for Hashswap token launch platform can be found on the `Launcher` SDK object

All public methods for Hashswap influencer registration platform can be found on the `Register` SDK object

This repository is under active development.
