// Copyright 2019-2022 @subwallet/extension-koni authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { withErrorLog } from '@subwallet/extension-base/background/handlers/helpers';
import State, { AuthUrls, Resolver } from '@subwallet/extension-base/background/handlers/State';
import { AccountRefMap, APIItemState, ApiMap, AuthRequestV2, BalanceItem, BalanceJson, ChainRegistry, CrowdloanItem, CrowdloanJson, CurrentAccountInfo, CustomEvmToken, DeleteEvmTokenParams, EvmTokenJson, NETWORK_STATUS, NetworkJson, NftCollection, NftCollectionJson, NftItem, NftJson, NftTransferExtra, PriceJson, RequestSettingsType, ResultResolver, ServiceInfo, StakingItem, StakingJson, StakingRewardJson, TokenInfo, TransactionHistoryItemType } from '@subwallet/extension-base/background/KoniTypes';
import { AuthorizeRequest, RequestAuthorizeTab } from '@subwallet/extension-base/background/types';
import { getId } from '@subwallet/extension-base/utils/getId';
import { getTokenPrice } from '@subwallet/extension-koni-base/api/coingecko';
import { initApi } from '@subwallet/extension-koni-base/api/dotsama';
import { cacheRegistryMap, getRegistry } from '@subwallet/extension-koni-base/api/dotsama/registry';
import { PREDEFINED_GENESIS_HASHES, PREDEFINED_NETWORKS } from '@subwallet/extension-koni-base/api/predefinedNetworks';
import { DEFAULT_STAKING_NETWORKS } from '@subwallet/extension-koni-base/api/staking';
// eslint-disable-next-line camelcase
import { DotSamaCrowdloan_crowdloans_nodes } from '@subwallet/extension-koni-base/api/subquery/__generated__/DotSamaCrowdloan';
import { fetchDotSamaCrowdloan } from '@subwallet/extension-koni-base/api/subquery/crowdloan';
import { DEFAULT_EVM_TOKENS } from '@subwallet/extension-koni-base/api/web3/defaultEvmToken';
import { initWeb3Api } from '@subwallet/extension-koni-base/api/web3/web3';
import { ALL_ACCOUNT_KEY } from '@subwallet/extension-koni-base/constants';
import { CurrentAccountStore, NetworkMapStore, PriceStore } from '@subwallet/extension-koni-base/stores';
import AccountRefStore from '@subwallet/extension-koni-base/stores/AccountRef';
import AuthorizeStore from '@subwallet/extension-koni-base/stores/Authorize';
import BalanceStore from '@subwallet/extension-koni-base/stores/Balance';
import CrowdloanStore from '@subwallet/extension-koni-base/stores/Crowdloan';
import CustomEvmTokenStore from '@subwallet/extension-koni-base/stores/CustomEvmToken';
import NftStore from '@subwallet/extension-koni-base/stores/Nft';
import NftCollectionStore from '@subwallet/extension-koni-base/stores/NftCollection';
import SettingsStore from '@subwallet/extension-koni-base/stores/Settings';
import StakingStore from '@subwallet/extension-koni-base/stores/Staking';
import TransactionHistoryStore from '@subwallet/extension-koni-base/stores/TransactionHistoryV2';
import { convertFundStatus, getCurrentProvider, mergeNetworkProviders } from '@subwallet/extension-koni-base/utils/utils';
import { BehaviorSubject, Subject } from 'rxjs';
import Web3 from 'web3';

import { accounts } from '@polkadot/ui-keyring/observable/accounts';
import { assert } from '@polkadot/util';

function generateDefaultStakingMap () {
  const stakingMap: Record<string, StakingItem> = {};

  Object.keys(DEFAULT_STAKING_NETWORKS).forEach((networkKey) => {
    stakingMap[networkKey] = {
      name: PREDEFINED_NETWORKS[networkKey].chain,
      chainId: networkKey,
      nativeToken: PREDEFINED_NETWORKS[networkKey].nativeToken,
      state: APIItemState.PENDING
    } as StakingItem;
  });

  return stakingMap;
}

function generateDefaultCrowdloanMap () {
  const crowdloanMap: Record<string, CrowdloanItem> = {};

  Object.keys(PREDEFINED_NETWORKS).forEach((networkKey) => {
    crowdloanMap[networkKey] = {
      state: APIItemState.PENDING,
      contribute: '0'
    };
  });

  return crowdloanMap;
}

export default class KoniState extends State {
  public readonly authSubjectV2: BehaviorSubject<AuthorizeRequest[]> = new BehaviorSubject<AuthorizeRequest[]>([]);

  private readonly balanceStore = new BalanceStore();
  private readonly crowdloanStore = new CrowdloanStore();
  private readonly stakingStore = new StakingStore();
  private readonly nftStore = new NftStore();
  private readonly nftCollectionStore = new NftCollectionStore();
  private readonly networkMapStore = new NetworkMapStore(); // persist custom networkMap by user
  private readonly customEvmTokenStore = new CustomEvmTokenStore();
  private readonly priceStore = new PriceStore();
  private readonly currentAccountStore = new CurrentAccountStore();
  private readonly settingsStore = new SettingsStore();
  private readonly accountRefStore = new AccountRefStore();
  private readonly authorizeStore = new AuthorizeStore();
  readonly #authRequestsV2: Record<string, AuthRequestV2> = {};
  private priceStoreReady = false;
  private readonly transactionHistoryStore = new TransactionHistoryStore();

  private networkMap: Record<string, NetworkJson> = {}; // mapping to networkMapStore, for uses in background
  private networkMapSubject = new Subject<Record<string, NetworkJson>>();
  private lockNetworkMap = false;
  private networkHashMap: Record<string, string> = {}; // mapping hash to network key

  private apiMap: ApiMap = { dotSama: {}, web3: {} };

  private serviceInfoSubject = new Subject<ServiceInfo>();

  private evmTokenState: EvmTokenJson = { erc20: [], erc721: [] };
  private evmTokenSubject = new Subject<EvmTokenJson>();

  private balanceMap: Record<string, BalanceItem> = this.generateDefaultBalanceMap();
  private balanceSubject = new Subject<BalanceJson>();

  // eslint-disable-next-line camelcase
  private crowdloanFundMap: Record<string, DotSamaCrowdloan_crowdloans_nodes> = {};
  private crowdloanMap: Record<string, CrowdloanItem> = generateDefaultCrowdloanMap();
  private crowdloanSubject = new Subject<CrowdloanJson>();

  private nftTransferSubject = new Subject<NftTransferExtra>();
  // Only for rendering nft after transfer
  private nftTransferState: NftTransferExtra = {
    cronUpdate: false,
    forceUpdate: false
  };

  private nftState: NftJson = {
    total: 0,
    nftList: []
  };

  private nftCollectionState: NftCollectionJson = {
    ready: false,
    nftCollectionList: []
  };

  private nftSubject = new Subject<NftJson>();
  private nftCollectionSubject = new Subject<NftCollectionJson>();

  private stakingSubject = new Subject<StakingJson>();
  private stakingRewardSubject = new Subject<StakingRewardJson>();
  private stakingMap: Record<string, StakingItem> = generateDefaultStakingMap();
  private stakingRewardState: StakingRewardJson = {
    ready: false,
    details: []
  } as StakingRewardJson;

  private historyMap: Record<string, TransactionHistoryItemType[]> = {};
  private historySubject = new Subject<Record<string, TransactionHistoryItemType[]>>();

  private chainRegistryMap: Record<string, ChainRegistry> = {};
  private chainRegistrySubject = new Subject<Record<string, ChainRegistry>>();

  private lazyMap: Record<string, unknown> = {};

  public generateDefaultBalanceMap () {
    const balanceMap: Record<string, BalanceItem> = {};

    Object.values(this.networkMap).forEach((networkJson) => {
      if (networkJson.active) {
        balanceMap[networkJson.key] = {
          state: APIItemState.PENDING
        };
      }
    });

    return balanceMap;
  }

  // init networkMap, apiMap and chainRegistry (first time only)
  // TODO: merge transactionHistory when custom network -> predefined network
  public initNetworkStates () {
    this.networkMapStore.get('NetworkMap', (storedNetworkMap) => {
      if (!storedNetworkMap) { // first time init extension
        this.networkMapStore.set('NetworkMap', PREDEFINED_NETWORKS);
        this.networkMap = PREDEFINED_NETWORKS;
      } else { // merge custom providers in stored data with predefined data
        const mergedNetworkMap: Record<string, NetworkJson> = PREDEFINED_NETWORKS;

        for (const [key, storedNetwork] of Object.entries(storedNetworkMap)) {
          if (key in PREDEFINED_NETWORKS) {
            // check change and override custom providers if exist
            if ('customProviders' in storedNetwork) {
              mergedNetworkMap[key].customProviders = storedNetwork.customProviders;
            }

            mergedNetworkMap[key].active = storedNetwork.active;
            mergedNetworkMap[key].currentProvider = storedNetwork.currentProvider;
            mergedNetworkMap[key].coinGeckoKey = storedNetwork.coinGeckoKey;
            mergedNetworkMap[key].crowdloanUrl = storedNetwork.crowdloanUrl;
            mergedNetworkMap[key].blockExplorer = storedNetwork.blockExplorer;
            mergedNetworkMap[key].currentProviderMode = mergedNetworkMap[key].currentProvider.startsWith('http') ? 'http' : 'ws';
          } else {
            if (Object.keys(PREDEFINED_GENESIS_HASHES).includes(storedNetwork.genesisHash)) { // merge networks with same genesis hash
              // @ts-ignore
              const targetKey = PREDEFINED_GENESIS_HASHES[storedNetwork.genesisHash];

              const { currentProviderMethod, parsedCustomProviders, parsedProviderKey } = mergeNetworkProviders(storedNetwork, PREDEFINED_NETWORKS[targetKey]);

              mergedNetworkMap[targetKey].customProviders = parsedCustomProviders;
              mergedNetworkMap[targetKey].currentProvider = parsedProviderKey;
              mergedNetworkMap[targetKey].active = storedNetwork.active;
              // @ts-ignore
              mergedNetworkMap[targetKey].currentProviderMode = currentProviderMethod;
            } else {
              mergedNetworkMap[key] = storedNetwork;
            }
          }
        }

        this.networkMapStore.set('NetworkMap', mergedNetworkMap);
        this.networkMap = mergedNetworkMap; // init networkMap state

        this.networkHashMap = Object.values(this.networkMap).reduce((data: Record<string, string>, cur) => {
          data[cur.genesisHash] = cur.key;

          return data;
        }, {});
      }

      for (const [key, network] of Object.entries(this.networkMap)) {
        if (network.active) {
          this.apiMap.dotSama[key] = initApi(key, getCurrentProvider(network), network.isEthereum);

          if (network.isEthereum && network.isEthereum) {
            this.apiMap.web3[key] = initWeb3Api(getCurrentProvider(network));
          }
        }
      }

      this.initEvmTokenState();
    });
  }

  public initEvmTokenState () {
    this.customEvmTokenStore.get('EvmToken', (storedEvmTokens) => {
      if (!storedEvmTokens) {
        this.evmTokenState = DEFAULT_EVM_TOKENS;
      } else {
        const _evmTokenState = storedEvmTokens;

        for (const storedToken of DEFAULT_EVM_TOKENS.erc20) {
          let exist = false;

          for (const defaultToken of storedEvmTokens.erc20) {
            if (defaultToken.smartContract === storedToken.smartContract && defaultToken.chain === storedToken.chain) {
              exist = true;
              break;
            }
          }

          if (!exist) {
            _evmTokenState.erc20.push(storedToken);
          }
        }

        for (const storedToken of DEFAULT_EVM_TOKENS.erc721) {
          let exist = false;

          for (const defaultToken of storedEvmTokens.erc721) {
            if (defaultToken.smartContract === storedToken.smartContract && defaultToken.chain === storedToken.chain) {
              exist = true;
              break;
            }
          }

          if (!exist) {
            _evmTokenState.erc721.push(storedToken);
          }
        }

        // Update networkKey in case networkMap change
        for (const token of _evmTokenState.erc20) {
          if (!(token.chain in this.networkMap)) {
            let newKey = '';
            const genesisHash = token.chain.split('custom_')[1]; // token from custom network has key with prefix custom_

            for (const [key, network] of Object.entries(this.networkMap)) {
              if (network.genesisHash.toLowerCase() === genesisHash.toLowerCase()) {
                newKey = key;
                break;
              }
            }

            token.chain = newKey;
          }
        }

        for (const token of _evmTokenState.erc721) {
          if (!(token.chain in this.networkMap)) {
            let newKey = '';
            const genesisHash = token.chain.split('custom_')[1]; // token from custom network has key with prefix custom_

            for (const [key, network] of Object.entries(this.networkMap)) {
              if (network.genesisHash.toLowerCase() === genesisHash.toLowerCase()) {
                newKey = key;
                break;
              }
            }

            token.chain = newKey;
          }
        }

        this.evmTokenState = _evmTokenState;
      }

      this.customEvmTokenStore.set('EvmToken', this.evmTokenState);
      this.evmTokenSubject.next(this.evmTokenState);

      this.initChainRegistry();
    });
  }

  private lazyNext = (key: string, callback: () => void) => {
    if (this.lazyMap[key]) {
      // @ts-ignore
      clearTimeout(this.lazyMap[key]);
    }

    const lazy = setTimeout(() => {
      callback();
      clearTimeout(lazy);
    }, 300);

    this.lazyMap[key] = lazy;
  };

  public getAuthRequestV2 (id: string): AuthRequestV2 {
    return this.#authRequestsV2[id];
  }

  public get numAuthRequestsV2 (): number {
    return Object.keys(this.#authRequestsV2).length;
  }

  public get allAuthRequestsV2 (): AuthorizeRequest[] {
    return Object
      .values(this.#authRequestsV2)
      .map(({ id, request, url }): AuthorizeRequest => ({ id, request, url }));
  }

  public setAuthorize (data: AuthUrls, callback?: () => void): void {
    this.authorizeStore.set('authUrls', data, callback);
  }

  public getAuthorize (update: (value: AuthUrls) => void): void {
    this.authorizeStore.get('authUrls', update);
  }

  private updateIconV2 (shouldClose?: boolean): void {
    const authCount = this.numAuthRequestsV2;
    const text = (
      authCount
        ? 'Auth'
        : ''
    );

    withErrorLog(() => chrome.browserAction.setBadgeText({ text }));

    if (shouldClose && text === '') {
      this.popupClose();
    }
  }

  public getAuthList (): Promise<AuthUrls> {
    return new Promise<AuthUrls>((resolve, reject) => {
      this.getAuthorize((rs: AuthUrls) => {
        resolve(rs);
      });
    });
  }

  getAddressList (value = false): Record<string, boolean> {
    const addressList = Object.keys(accounts.subject.value)
      .filter((address) => accounts.subject.value[address].type !== 'ethereum');
    const addressListMap = addressList.reduce((addressList, v) => ({ ...addressList, [v]: value }), {});

    return addressListMap;
  }

  private updateIconAuthV2 (shouldClose?: boolean): void {
    this.authSubjectV2.next(this.allAuthRequestsV2);
    this.updateIconV2(shouldClose);
  }

  private authCompleteV2 = (id: string, resolve: (result: boolean) => void, reject: (error: Error) => void): Resolver<ResultResolver> => {
    const isAllowedMap = this.getAddressList();

    const complete = (result: boolean | Error, accounts?: string[]) => {
      const isAllowed = result === true;

      if (accounts && accounts.length) {
        accounts.forEach((acc) => {
          isAllowedMap[acc] = true;
        });
      } else {
        // eslint-disable-next-line no-return-assign
        Object.keys(isAllowedMap).forEach((address) => isAllowedMap[address] = false);
      }

      const { idStr, request: { origin }, url } = this.#authRequestsV2[id];

      this.getAuthorize((value) => {
        let authorizeList = {} as AuthUrls;

        if (value) {
          authorizeList = value;
        }

        authorizeList[this.stripUrl(url)] = {
          count: 0,
          id: idStr,
          isAllowed,
          isAllowedMap,
          origin,
          url
        };

        this.setAuthorize(authorizeList);
        delete this.#authRequestsV2[id];
        this.updateIconAuthV2(true);
      });
    };

    return {
      reject: (error: Error): void => {
        complete(error);
        reject(error);
      },
      resolve: ({ accounts, result }: ResultResolver): void => {
        complete(result, accounts);
        resolve(result);
      }
    };
  };

  public async authorizeUrlV2 (url: string, request: RequestAuthorizeTab): Promise<boolean> {
    let authList = await this.getAuthList();

    if (!authList) {
      authList = {};
    }

    const idStr = this.stripUrl(url);
    // Do not enqueue duplicate authorization requests.
    const isDuplicate = Object.values(this.#authRequestsV2)
      .some((request) => request.idStr === idStr);

    assert(!isDuplicate, `The source ${url} has a pending authorization request`);

    if (authList[idStr]) {
      // this url was seen in the past
      const isConnected = Object.keys(authList[idStr].isAllowedMap)
        .some((address) => authList[idStr].isAllowedMap[address]);

      assert(isConnected, `The source ${url} is not allowed to interact with this extension`);

      return false;
    }

    return new Promise((resolve, reject): void => {
      const id = getId();

      this.#authRequestsV2[id] = {
        ...this.authCompleteV2(id, resolve, reject),
        id,
        idStr,
        request,
        url
      };

      this.updateIconAuthV2();

      if (Object.keys(this.#authRequestsV2).length < 2) {
        this.popupOpen();
      }
    });
  }

  public getStaking (): StakingJson {
    return { ready: true, details: this.stakingMap } as StakingJson;
  }

  public async getStoredStaking (address: string) {
    const items = await this.stakingStore.asyncGet(address);

    return items || {};
  }

  public subscribeStaking () {
    return this.stakingSubject;
  }

  public ensureUrlAuthorizedV2 (url: string): boolean {
    const idStr = this.stripUrl(url);

    this.getAuthorize((value) => {
      if (!value) {
        value = {};
      }

      const isConnected = Object.keys(value[idStr].isAllowedMap)
        .some((address) => value[idStr].isAllowedMap[address]);
      const entry = Object.keys(value).includes(idStr);

      assert(entry, `The source ${url} has not been enabled yet`);
      assert(isConnected, `The source ${url} is not allowed to interact with this extension`);
    });

    return true;
  }

  private hasUpdateStakingItem (networkKey: string, item: StakingItem): boolean {
    if (item.state !== APIItemState.READY) {
      return false;
    }

    const oldItem = this.stakingMap[networkKey];

    return oldItem?.balance !== item?.balance || !oldItem || oldItem?.state === APIItemState.PENDING;
  }

  public setStakingItem (networkKey: string, item: StakingItem): void {
    const itemData = { ...item, timestamp: +new Date() };

    if (this.hasUpdateStakingItem(networkKey, item)) {
      // Update staking map
      this.stakingMap[networkKey] = itemData;

      this.lazyNext('setStakingItem', () => {
        this.updateStakingStore();
        this.stakingSubject.next(this.getStaking());
      });
    }
  }

  private updateStakingStore () {
    const readyMap: Record<string, StakingItem> = {};

    Object.entries(this.stakingMap).forEach(([key, item]) => {
      if (item.state === APIItemState.READY) {
        readyMap[key] = item;
      }
    });

    if (Object.keys(readyMap).length > 0) {
      this.getCurrentAccount((currentAccountInfo) => {
        this.stakingStore.set(currentAccountInfo.address, readyMap);
      });
    }
  }

  public setNftTransfer (data: NftTransferExtra, callback?: (data: NftTransferExtra) => void): void {
    this.nftTransferState = data;

    if (callback) {
      callback(data);
    }

    this.nftTransferSubject.next(data);
  }

  public getNftTransfer (): NftTransferExtra {
    return this.nftTransferState;
  }

  public getNftTransferSubscription (update: (value: NftTransferExtra) => void): void {
    update(this.nftTransferState);
  }

  public subscribeNftTransfer () {
    return this.nftTransferSubject;
  }

  public setNftCollection (address: string, data: NftCollectionJson, callback?: (data: NftCollectionJson) => void): void {
    this.getCurrentAccount((currentAccountInfo) => {
      if (currentAccountInfo.address === address) {
        this.nftCollectionState = data;

        if (callback) {
          callback(data);
        }

        this.publishNftCollectionChanged(address);
      }
    });
  }

  public updateNftCollection (address: string, data: NftCollection, callback?: (data: NftCollection) => void): void {
    this.getCurrentAccount((currentAccountInfo) => {
      if (currentAccountInfo.address === address) {
        this.nftCollectionState.nftCollectionList.push(data);

        if (callback) {
          callback(data);
        }

        this.publishNftCollectionChanged(address);
      }
    });
  }

  public updateNftReady (address: string, ready: boolean, callback?: (ready: boolean) => void): void {
    this.getCurrentAccount((currentAccountInfo) => {
      if (currentAccountInfo.address === address) {
        if (callback) {
          callback(ready);
        }

        if (this.nftCollectionState.ready !== ready) {
          this.nftCollectionState.ready = ready;

          this.publishNftCollectionChanged(address);
        }
      }
    });
  }

  private publishNftCollectionChanged (address: string) {
    this.lazyNext('saveNftCollection', () => {
      this.saveNftCollection(address);
      this.nftCollectionSubject.next(this.nftCollectionState);
    });
  }

  private saveNftCollection (address: string, clear = false) {
    if (clear) {
      this.nftCollectionStore.remove(address);
    } else if (this.nftCollectionState.ready && this.nftCollectionState.nftCollectionList) {
      this.nftCollectionStore.set(address, this.nftCollectionState.nftCollectionList);
    }
  }

  public async resetNftCollection (newAddress: string): Promise<void> {
    this.nftCollectionState = {
      ready: false,
      nftCollectionList: []
    } as NftCollectionJson;

    const storedData = await this.getStoredNftCollection(newAddress);

    if (storedData) {
      this.nftCollectionState.ready = true;
      this.nftCollectionState.nftCollectionList = storedData;
    }

    this.nftCollectionSubject.next(this.nftCollectionState);
  }

  public getNftCollection () {
    return this.nftCollectionState;
  }

  public async getStoredNftCollection (address: string) {
    const items = await this.nftCollectionStore.asyncGet(address);

    return items;
  }

  public getNftCollectionSubscription (update: (value: NftCollectionJson) => void): void {
    update(this.nftCollectionState);
  }

  public subscribeNftCollection () {
    return this.nftCollectionSubject;
  }

  public async resetNft (newAddress: string): Promise<void> {
    this.nftState = {
      total: 0,
      nftList: []
    } as NftJson;

    const storedData = await this.getStoredNft(newAddress);

    if (storedData) {
      this.nftState = storedData;
    }

    this.nftSubject.next(this.nftState);
  }

  // For NFT transfer
  public setNft (address: string, data: NftJson, callback?: (nftData: NftJson) => void): void {
    this.getCurrentAccount((currentAccountInfo) => {
      if (currentAccountInfo.address === address) {
        this.nftState = data;

        if (callback) {
          callback(data);
        }

        this.publishNftChanged(address);
      }
    });
  }

  public updateNft (address: string, nftData: NftItem, callback?: (nftData: NftItem) => void): void {
    this.getCurrentAccount((currentAccountInfo) => {
      if (currentAccountInfo.address === address) {
        this.nftState.nftList.push(nftData);

        if (callback) {
          callback(nftData);
        }

        this.publishNftChanged(address);
      }
    });
  }

  public resetMasterNftStore (): void {
    this.saveNft(ALL_ACCOUNT_KEY, true);
    this.saveNftCollection(ALL_ACCOUNT_KEY, true);
  }

  private publishNftChanged (address: string) {
    this.lazyNext('saveNft', () => {
      this.saveNft(address);
      this.nftSubject.next(this.nftState);
    });
  }

  private saveNft (address: string, clear = false) {
    if (clear) {
      this.nftStore.remove(address);
    } else if (this.nftState && this.nftState.nftList) {
      this.nftStore.set(address, this.nftState);
    }
  }

  public getNft () {
    return this.nftState;
  }

  public async getStoredNft (address: string) {
    const items = await this.nftStore.asyncGet(address);

    return items;
  }

  public getNftSubscription (update: (value: NftJson) => void): void {
    update(this.nftState);
  }

  public subscribeNft () {
    return this.nftSubject;
  }

  public setStakingReward (stakingRewardData: StakingRewardJson, callback?: (stakingRewardData: StakingRewardJson) => void): void {
    this.stakingRewardState = stakingRewardData;

    if (callback) {
      callback(stakingRewardData);
    }

    this.stakingRewardSubject.next(stakingRewardData);
  }

  public updateStakingRewardReady (ready: boolean) {
    this.stakingRewardState.ready = ready;
    this.stakingRewardSubject.next(this.stakingRewardState);
  }

  public getAccountRefMap (callback: (refMap: Record<string, Array<string>>) => void) {
    const refMap: AccountRefMap = {};

    this.accountRefStore.get('refList', (refList) => {
      if (refList) {
        refList.forEach((accRef) => {
          accRef.forEach((acc) => {
            refMap[acc] = [...accRef].filter((r) => !(r === acc));
          });
        });
      }

      callback(refMap);
    });
  }

  public addAccountRef (addresses: string[], callback: () => void) {
    this.accountRefStore.get('refList', (refList) => {
      const newList = refList ? [...refList] : [];

      newList.push(addresses);

      this.accountRefStore.set('refList', newList, callback);
    });
  }

  public removeAccountRef (address: string, callback: () => void) {
    this.accountRefStore.get('refList', (refList) => {
      if (refList) {
        refList.forEach((accRef) => {
          if (accRef.indexOf(address) > -1) {
            accRef.splice(accRef.indexOf(address), 1);
          }

          if (accRef.length < 2) {
            refList.splice(refList.indexOf(accRef), 1);
          }
        });

        this.accountRefStore.set('refList', refList, () => {
          callback();
        });
      } else {
        callback();
      }
    });
  }

  public getStakingReward (update: (value: StakingRewardJson) => void): void {
    update(this.stakingRewardState);
  }

  public subscribeStakingReward () {
    return this.stakingRewardSubject;
  }

  public setHistory (address: string, network: string, histories: TransactionHistoryItemType[]) {
    const oldItems = this.historyMap[network] || [];

    const comnbinedHistories = this.combineHistories(oldItems, histories);

    this.historyMap[network] = comnbinedHistories;

    this.lazyNext('setHistory', () => {
      // Save to storage
      this.saveHistoryToStorage(address);
      this.historySubject.next(this.getHistoryMap());
    });
  }

  public getCurrentAccount (update: (value: CurrentAccountInfo) => void): void {
    this.currentAccountStore.get('CurrentAccountInfo', update);
  }

  public setCurrentAccount (data: CurrentAccountInfo, callback?: () => void): void {
    this.currentAccountStore.set('CurrentAccountInfo', data, callback);

    this.updateServiceInfo();
  }

  public getSettings (update: (value: RequestSettingsType) => void): void {
    this.settingsStore.get('Settings', (value) => {
      if (!value) {
        update({ isShowBalance: false, accountAllLogo: '', theme: 'dark' });
      } else {
        update(value);
      }
    });
  }

  public setSettings (data: RequestSettingsType, callback?: () => void): void {
    this.settingsStore.set('Settings', data, callback);
  }

  public subscribeSettingsSubject (): Subject<RequestSettingsType> {
    return this.settingsStore.getSubject();
  }

  public subscribeCurrentAccount (): Subject<CurrentAccountInfo> {
    return this.currentAccountStore.getSubject();
  }

  public getAccountAddress () {
    return new Promise((resolve, reject) => {
      this.getCurrentAccount((account) => {
        if (account) {
          resolve(account.address);
        } else {
          resolve(null);
        }
      });
    });
  }

  public getBalance (): BalanceJson {
    return { details: this.balanceMap } as BalanceJson;
  }

  public async getStoredBalance (address: string) {
    const items = await this.balanceStore.asyncGet(address);

    return items || {};
  }

  public async switchAccount (newAddress: string) {
    await Promise.all([
      this.resetBalanceMap(newAddress),
      this.resetCrowdloanMap(newAddress)
    ]);
  }

  public async resetBalanceMap (newAddress: string) {
    this.balanceMap = {};
    const defaultData = this.generateDefaultBalanceMap();
    const storedData = await this.getStoredBalance(newAddress);

    const merge = { ...defaultData, ...storedData } as Record<string, BalanceItem>;

    this.balanceSubject.next({ details: merge });
  }

  public async resetCrowdloanMap (newAddress: string) {
    this.crowdloanMap = {};
    const defaultData = generateDefaultCrowdloanMap();
    const storedData = await this.getStoredCrowdloan(newAddress);

    const merge = { ...defaultData, ...storedData } as Record<string, CrowdloanItem>;

    this.crowdloanSubject.next({ details: merge });
  }

  public async resetStakingMap (newAddress: string) {
    this.stakingMap = {};
    const defaultData = generateDefaultStakingMap();
    const storedData = await this.getStoredStaking(newAddress);

    const merge = { ...defaultData, ...storedData } as Record<string, StakingItem>;

    this.stakingSubject.next({ ready: false, details: merge });
  }

  public setBalanceItem (networkKey: string, item: BalanceItem) {
    const itemData = { ...item, timestamp: +new Date() };

    this.balanceMap[networkKey] = itemData;

    this.lazyNext('setBalanceItem', () => {
      this.updateBalanceStore();
      this.balanceSubject.next(this.getBalance());
    });
  }

  private updateBalanceStore () {
    const readyBalanceMap: Record<string, BalanceItem> = {};

    Object.entries(this.balanceMap).forEach(([key, balanceItem]) => {
      if (balanceItem.state === APIItemState.READY) {
        readyBalanceMap[key] = balanceItem;
      }
    });
    this.getCurrentAccount((currentAccountInfo) => {
      this.balanceStore.set(currentAccountInfo.address, readyBalanceMap);
    });
  }

  public subscribeBalance () {
    return this.balanceSubject;
  }

  public async fetchCrowdloanFundMap () {
    this.crowdloanFundMap = await fetchDotSamaCrowdloan();
  }

  public getCrowdloan (): CrowdloanJson {
    return { details: this.crowdloanMap } as CrowdloanJson;
  }

  public async getStoredCrowdloan (address: string) {
    const items = await this.crowdloanStore.asyncGet(address);

    return items || {};
  }

  public setCrowdloanItem (networkKey: string, item: CrowdloanItem) {
    const itemData = { ...item, timestamp: +new Date() };
    // Fill para state
    const crowdloanFundNode = this.crowdloanFundMap[networkKey];

    if (crowdloanFundNode) {
      itemData.paraState = convertFundStatus(crowdloanFundNode.status);
    }

    // Update crowdloan map
    this.crowdloanMap[networkKey] = itemData;

    this.lazyNext('setCrowdloanItem', () => {
      this.updateCrowdloanStore();
      this.crowdloanSubject.next(this.getCrowdloan());
    });
  }

  private updateCrowdloanStore () {
    const readyMap: Record<string, CrowdloanItem> = {};

    Object.entries(this.crowdloanMap).forEach(([key, item]) => {
      if (item.state === APIItemState.READY) {
        readyMap[key] = item;
      }
    });
    this.getCurrentAccount((currentAccountInfo) => {
      this.crowdloanStore.set(currentAccountInfo.address, readyMap);
    });
  }

  public subscribeCrowdloan () {
    return this.crowdloanSubject;
  }

  public getChainRegistryMap (): Record<string, ChainRegistry> {
    return this.chainRegistryMap;
  }

  public setChainRegistryItem (networkKey: string, registry: ChainRegistry) {
    this.chainRegistryMap[networkKey] = registry;
    this.lazyNext('setChainRegistry', () => {
      this.chainRegistrySubject.next(this.getChainRegistryMap());
    });
  }

  public upsertChainRegistry (tokenData: CustomEvmToken) {
    const chainRegistry = this.chainRegistryMap[tokenData.chain];
    let tokenKey = '';

    for (const [key, token] of Object.entries(chainRegistry.tokenMap)) {
      if (token.erc20Address === tokenData.smartContract) {
        tokenKey = key;
        break;
      }
    }

    if (tokenKey !== '') {
      chainRegistry.tokenMap[tokenKey] = {
        isMainToken: false,
        symbol: tokenData.symbol,
        name: tokenData.name,
        erc20Address: tokenData.smartContract,
        decimals: tokenData.decimals
      } as TokenInfo;
    } else {
      // @ts-ignore
      chainRegistry.tokenMap[tokenData.symbol] = {
        isMainToken: false,
        symbol: tokenData.symbol,
        name: tokenData.symbol,
        erc20Address: tokenData.smartContract,
        decimals: tokenData.decimals
      } as TokenInfo;
    }

    cacheRegistryMap[tokenData.chain] = chainRegistry;
    this.chainRegistrySubject.next(this.getChainRegistryMap());
  }

  public initChainRegistry () {
    this.chainRegistryMap = {};
    this.getEvmTokenStore((evmTokens) => {
      const erc20Tokens: CustomEvmToken[] = evmTokens ? evmTokens.erc20 : [];

      if (evmTokens) {
        evmTokens.erc20.forEach((token) => {
          if (!token.isDeleted) {
            erc20Tokens.push(token);
          }
        });
      }

      Object.entries(this.apiMap.dotSama).forEach(([networkKey, { api }]) => {
        getRegistry(networkKey, api, erc20Tokens)
          .then((rs) => {
            this.setChainRegistryItem(networkKey, rs);
          })
          .catch(console.error);
      });
    });

    Object.entries(this.apiMap.dotSama).forEach(([networkKey, { api }]) => {
      getRegistry(networkKey, api)
        .then((rs) => {
          this.setChainRegistryItem(networkKey, rs);
        })
        .catch(console.error);
    });
  }

  public subscribeChainRegistryMap () {
    return this.chainRegistrySubject;
  }

  private getTransactionKey (address: string, networkKey: string): string {
    return `${address}_${networkKey}`;
  }

  private getStorageKey (prefix: string, address: string): string {
    return `${prefix}_${address}`;
  }

  public getTransactionHistory (address: string, networkKey: string, update: (items: TransactionHistoryItemType[]) => void): void {
    const items = this.historyMap[networkKey];

    if (!items) {
      update([]);
    } else {
      update(items);
    }
  }

  public subscribeHistory () {
    return this.historySubject;
  }

  public getHistoryMap (): Record<string, TransactionHistoryItemType[]> {
    return this.historyMap;
  }

  public setTransactionHistory (address: string, networkKey: string, item: TransactionHistoryItemType, callback?: (items: TransactionHistoryItemType[]) => void): void {
    const items = this.historyMap[networkKey] || [];

    item.origin = 'app';

    items.unshift(item);
    this.historyMap[networkKey] = items;

    // Save to storage
    this.saveHistoryToStorage(address);

    this.historySubject.next(this.getHistoryMap());
    callback && callback(items);
  }

  public setPrice (priceData: PriceJson, callback?: (priceData: PriceJson) => void): void {
    this.priceStore.set('PriceData', priceData, () => {
      if (callback) {
        callback(priceData);
        this.priceStoreReady = true;
      }
    });
  }

  public getPrice (update: (value: PriceJson) => void): void {
    this.priceStore.get('PriceData', (rs) => {
      if (this.priceStoreReady) {
        update(rs);
      } else {
        const activeNetworks: string[] = [];

        Object.values(this.networkMap).forEach((network) => {
          if (network.active && network.coinGeckoKey) {
            activeNetworks.push(network.coinGeckoKey);
          }
        });

        getTokenPrice(activeNetworks)
          .then((rs) => {
            this.setPrice(rs);
            update(rs);
          })
          .catch((err) => {
            console.error(err);
            throw err;
          });
      }
    });
  }

  public subscribePrice () {
    return this.priceStore.getSubject();
  }

  public subscribeEvmToken () {
    return this.evmTokenSubject;
  }

  public getEvmTokenState () {
    return this.evmTokenState;
  }

  public getActiveErc20Tokens () {
    const filteredErc20Tokens: CustomEvmToken[] = [];

    this.evmTokenState.erc20.forEach((token) => {
      if (!token.isDeleted) {
        filteredErc20Tokens.push(token);
      }
    });

    return filteredErc20Tokens;
  }

  public getActiveErc721Tokens () {
    const filteredErc721Tokens: CustomEvmToken[] = [];

    this.evmTokenState.erc721.forEach((token) => {
      if (!token.isDeleted) {
        filteredErc721Tokens.push(token);
      }
    });

    return filteredErc721Tokens;
  }

  public getEvmTokenStore (callback: (data: EvmTokenJson) => void) {
    return this.customEvmTokenStore.get('EvmToken', (data) => {
      callback(data);
    });
  }

  public upsertEvmToken (data: CustomEvmToken) {
    let isExist = false;

    for (const token of this.evmTokenState[data.type]) {
      if (token.smartContract === data.smartContract && token.type === data.type && token.chain === data.chain) {
        isExist = true;
        break;
      }
    }

    if (!isExist) {
      this.evmTokenState[data.type].push(data);
    } else {
      this.evmTokenState[data.type] = this.evmTokenState[data.type].map((token) => {
        if (token.smartContract === data.smartContract) {
          return data;
        }

        return token;
      });
    }

    if (data.type === 'erc20') {
      this.upsertChainRegistry(data);
    }

    this.evmTokenSubject.next(this.evmTokenState);
    this.customEvmTokenStore.set('EvmToken', this.evmTokenState);
    this.updateServiceInfo();
  }

  public deleteEvmTokens (targetTokens: DeleteEvmTokenParams[]) {
    const _evmTokenState: EvmTokenJson = this.evmTokenState;
    let needUpdateChainRegistry = false;

    for (const targetToken of targetTokens) {
      for (let index = 0; index < _evmTokenState.erc20.length; index++) {
        if (_evmTokenState.erc20[index].smartContract === targetToken.smartContract && _evmTokenState.erc20[index].chain === targetToken.chain && targetToken.type === 'erc20') {
          if (_evmTokenState.erc20[index].isCustom) {
            _evmTokenState.erc20.splice(index, 1);
          } else {
            _evmTokenState.erc20[index].isDeleted = true;
          }

          needUpdateChainRegistry = true;
        }
      }
    }

    if (needUpdateChainRegistry) {
      for (const targetToken of targetTokens) {
        const chainRegistry = this.chainRegistryMap[targetToken.chain];
        let deleteKey = '';

        for (const [key, token] of Object.entries(chainRegistry.tokenMap)) {
          if (token.erc20Address === targetToken.smartContract && targetToken.type === 'erc20') {
            deleteKey = key;
          }
        }

        delete chainRegistry.tokenMap[deleteKey];
        this.chainRegistryMap[targetToken.chain] = chainRegistry;
        cacheRegistryMap[targetToken.chain] = chainRegistry;
      }
    }

    for (const targetToken of targetTokens) {
      for (let index = 0; index < _evmTokenState.erc721.length; index++) {
        if (_evmTokenState.erc721[index].smartContract === targetToken.smartContract && _evmTokenState.erc721[index].chain === targetToken.chain && targetToken.type === 'erc721') {
          if (_evmTokenState.erc721[index].isCustom) {
            _evmTokenState.erc721.splice(index, 1);
          } else {
            _evmTokenState.erc721[index].isDeleted = true;
          }
        }
      }
    }

    this.evmTokenState = _evmTokenState;
    this.evmTokenSubject.next(this.evmTokenState);
    this.chainRegistrySubject.next(this.getChainRegistryMap());
    this.customEvmTokenStore.set('EvmToken', this.evmTokenState);
    this.updateServiceInfo();
  }

  public getNetworkMap () {
    return this.networkMap;
  }

  public getNetworkMapByKey (key: string) {
    return this.networkMap[key];
  }

  public getEthereumChains (): string[] {
    const result: string[] = [];

    Object.keys(this.networkMap).forEach((k) => {
      if (this.networkMap[k].isEthereum) {
        result.push(k);
      }
    });

    return result;
  }

  public subscribeNetworkMap () {
    return this.networkMapStore.getSubject();
  }

  public async upsertNetworkMap (data: NetworkJson): Promise<boolean> {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;

    if (data.key in this.networkMap) { // update provider for existed network
      if (data.customProviders) {
        this.networkMap[data.key].customProviders = data.customProviders;
      }

      if (data.currentProvider !== this.networkMap[data.key].currentProvider) {
        this.networkMap[data.key].currentProvider = data.currentProvider;
        this.networkMap[data.key].currentProviderMode = data.currentProvider.startsWith('ws') ? 'ws' : 'http';
      }

      this.networkMap[data.key].chain = data.chain;

      if (data.nativeToken) {
        this.networkMap[data.key].nativeToken = data.nativeToken;
      }

      if (data.decimals) {
        this.networkMap[data.key].decimals = data.decimals;
      }

      this.networkMap[data.key].crowdloanUrl = data.crowdloanUrl;

      this.networkMap[data.key].coinGeckoKey = data.coinGeckoKey;

      this.networkMap[data.key].paraId = data.paraId;

      this.networkMap[data.key].blockExplorer = data.blockExplorer;
    } else { // insert
      this.networkMap[data.key] = data;
      this.networkMap[data.key].getStakingOnChain = true; // try to fetch staking on chain for custom network by default
      this.networkHashMap[data.genesisHash] = data.key;
    }

    if (this.networkMap[data.key].active) { // update API map if network is active
      if (data.key in this.apiMap.dotSama) {
        await this.apiMap.dotSama[data.key].api.disconnect();
        delete this.apiMap.dotSama[data.key];
      }

      if (data.isEthereum && data.key in this.apiMap.web3) {
        delete this.apiMap.web3[data.key];
      }

      this.apiMap.dotSama[data.key] = initApi(data.key, getCurrentProvider(data), data.isEthereum);

      if (data.isEthereum && data.isEthereum) {
        this.apiMap.web3[data.key] = initWeb3Api(getCurrentProvider(data));
      }
    }

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);
    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public removeNetworkMap (networkKey: string): boolean {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    delete this.networkMap[networkKey];

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);
    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public async disableNetworkMap (networkKey: string): Promise<boolean> {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    await this.apiMap.dotSama[networkKey].api.disconnect();
    delete this.apiMap.dotSama[networkKey];

    if (this.networkMap[networkKey].isEthereum && this.networkMap[networkKey].isEthereum) {
      delete this.apiMap.web3[networkKey];
    }

    this.networkMap[networkKey].active = false;
    this.networkMap[networkKey].apiStatus = NETWORK_STATUS.DISCONNECTED;
    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);
    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public async disableAllNetworks (): Promise<boolean> {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    const targetNetworkKeys: string[] = [];

    for (const [key, network] of Object.entries(this.networkMap)) {
      if (network.active) {
        targetNetworkKeys.push(key);
        this.networkMap[key].active = false;
      }
    }

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);

    for (const key of targetNetworkKeys) {
      await this.apiMap.dotSama[key].api.disconnect();
      delete this.apiMap.dotSama[key];

      if (this.networkMap[key].isEthereum && this.networkMap[key].isEthereum) {
        delete this.apiMap.web3[key];
      }

      this.networkMap[key].apiStatus = NETWORK_STATUS.DISCONNECTED;
    }

    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public enableNetworkMap (networkKey: string) {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    this.apiMap.dotSama[networkKey] = initApi(networkKey, getCurrentProvider(this.networkMap[networkKey]), this.networkMap[networkKey].isEthereum);

    if (this.networkMap[networkKey].isEthereum && this.networkMap[networkKey].isEthereum) {
      this.apiMap.web3[networkKey] = initWeb3Api(getCurrentProvider(this.networkMap[networkKey]));
    }

    this.networkMap[networkKey].active = true;
    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);
    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public enableAllNetworks () {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    const targetNetworkKeys: string[] = [];

    for (const [key, network] of Object.entries(this.networkMap)) {
      if (!network.active) {
        targetNetworkKeys.push(key);
        this.networkMap[key].active = true;
      }
    }

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);

    for (const key of targetNetworkKeys) {
      this.apiMap.dotSama[key] = initApi(key, getCurrentProvider(this.networkMap[key]), this.networkMap[key].isEthereum);

      if (this.networkMap[key].isEthereum && this.networkMap[key].isEthereum) {
        this.apiMap.web3[key] = initWeb3Api(getCurrentProvider(this.networkMap[key]));
      }
    }

    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public async resetDefaultNetwork () {
    if (this.lockNetworkMap) {
      return false;
    }

    this.lockNetworkMap = true;
    const targetNetworkKeys: string[] = [];

    for (const [key, network] of Object.entries(this.networkMap)) {
      if (!network.active) {
        if (key === 'polkadot' || key === 'kusama') {
          this.apiMap.dotSama[key] = initApi(key, getCurrentProvider(this.networkMap[key]), this.networkMap[key].isEthereum);
          this.networkMap[key].active = true;
        }
      } else {
        if (key !== 'polkadot' && key !== 'kusama') {
          targetNetworkKeys.push(key);

          this.networkMap[key].active = false;
          this.networkMap[key].apiStatus = NETWORK_STATUS.DISCONNECTED;
        }
      }
    }

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);

    for (const key of targetNetworkKeys) {
      await this.apiMap.dotSama[key].api.disconnect();
      delete this.apiMap.dotSama[key];

      if (this.networkMap[key].isEthereum && this.networkMap[key].isEthereum) {
        delete this.apiMap.web3[key];
      }
    }

    this.updateServiceInfo();
    this.lockNetworkMap = false;

    return true;
  }

  public updateNetworkStatus (networkKey: string, status: NETWORK_STATUS) {
    this.networkMap[networkKey].apiStatus = status;

    this.networkMapSubject.next(this.networkMap);
    this.networkMapStore.set('NetworkMap', this.networkMap);
  }

  public getDotSamaApiMap () {
    return this.apiMap.dotSama;
  }

  public getDotSamaApi (networkKey: string) {
    return this.apiMap.dotSama[networkKey];
  }

  public getWeb3ApiMap () {
    return this.apiMap.web3;
  }

  public getApiMap () {
    return this.apiMap;
  }

  public refreshDotSamaApi (key: string) {
    const apiProps = this.apiMap.dotSama[key];

    if (key in this.apiMap.dotSama) {
      if (!apiProps.isApiConnected) {
        apiProps.recoverConnect && apiProps.recoverConnect();
      }
    }

    return true;
  }

  public refreshWeb3Api (key: string) {
    this.apiMap.web3[key] = initWeb3Api(getCurrentProvider(this.networkMap[key]));
  }

  public subscribeServiceInfo () {
    return this.serviceInfoSubject;
  }

  public updateServiceInfo () {
    console.log('<---Update serviceInfo--->');
    this.currentAccountStore.get('CurrentAccountInfo', (value) => {
      this.serviceInfoSubject.next({
        networkMap: this.networkMap,
        apiMap: this.apiMap,
        currentAccountInfo: value,
        chainRegistry: this.chainRegistryMap,
        customErc721Registry: this.getActiveErc721Tokens()
      });
    });
  }

  public getNetworkGenesisHashByKey (key: string) {
    const network = this.networkMap[key];

    return network && network.genesisHash;
  }

  public getNetworkKeyByGenesisHash (hash: string) {
    return this.networkHashMap[hash];
  }

  public async resetHistoryMap (newAddress: string): Promise<void> {
    this.historyMap = {};

    const storedData = await this.getStoredHistories(newAddress);

    if (storedData) {
      this.historyMap = storedData;
    }

    this.historySubject.next(this.getHistoryMap());
  }

  public async getStoredHistories (address: string) {
    const data = await this.transactionHistoryStore.asyncGet(address);

    if (data) {
      return this.convertHashKeyToNetworkKey(data);
    }

    return undefined;
  }

  private saveHistoryToStorage (address: string) {
    const newestHistoryMap = this.convertNetworkKeyToHashKey(this.historyMap) as Record<string, TransactionHistoryItemType[]>;

    Object.entries(newestHistoryMap).forEach(([key, items]) => {
      if (!Array.isArray(items) || !items.length) {
        delete newestHistoryMap[key];
      }
    });

    this.transactionHistoryStore.set(address, newestHistoryMap);
  }

  private convertNetworkKeyToHashKey (object: Record<string, any> = {}) {
    return Object.entries(object).reduce((newObj: Record<string, any>, [key, data]) => {
      const hash = this.getNetworkGenesisHashByKey(key);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      newObj[hash] = data;

      return newObj;
    }, {});
  }

  private convertHashKeyToNetworkKey (object: Record<string, any> = {}) {
    return Object.entries(object).reduce((newObj: Record<string, any>, [hash, data]) => {
      const key = this.getNetworkKeyByGenesisHash(hash);

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      newObj[key] = data;

      return newObj;
    }, {});
  }

  private combineHistories (oldItems: TransactionHistoryItemType[], newItems: TransactionHistoryItemType[]): TransactionHistoryItemType[] {
    const newHistories = newItems.filter((item) => !oldItems.some((old) => this.isSameHistory(old, item)));

    return [...oldItems, ...newHistories].sort((a, b) => b.time - a.time);
  }

  public isSameHistory (oldItem: TransactionHistoryItemType, newItem: TransactionHistoryItemType): boolean {
    return oldItem.extrinsicHash === newItem.extrinsicHash;
  }

  public pauseAllNetworks (code?: number, reason?: string) {
    // Disconnect web3 networks
    // Object.entries(this.apiMap.web3).forEach(([key, network]) => {
    //   if (network.currentProvider instanceof Web3.providers.WebsocketProvider) {
    //     if (network.currentProvider?.connected) {
    //       console.log(`[Web3] ${key} is conected`);
    //       network.currentProvider?.disconnect(code, reason);
    //       console.log(`[Web3] ${key} is ${network.currentProvider.connected ? 'connected' : 'disconnected'} now`);
    //     }
    //   }
    // });

    // Disconnect dotsama networks
    return Promise.all(Object.values(this.apiMap.dotSama).map(async (network) => {
      if (network.api.isConnected) {
        console.log(`[Dotsama] Stopping network [${network.specName}]`);
        await network.api.disconnect();
      }
    }));
  }

  async resumeAllNetworks () {
    // Reconnect web3 networks
    // Object.entries(this.apiMap.web3).forEach(([key, network]) => {
    //   const currentProvider = network.currentProvider;

    //   if (currentProvider instanceof Web3.providers.WebsocketProvider) {
    //     if (!currentProvider.connected) {
    //       console.log(`[Web3] ${key} is disconected`);
    //       currentProvider?.connect();
    //       setTimeout(() => console.log(`[Web3] ${key} is ${currentProvider.connected ? 'connected' : 'disconnected'} now`), 500);
    //     }
    //   }
    // });

    // Reconnect dotsama networks
    return Promise.all(Object.values(this.apiMap.dotSama).map(async (network) => {
      if (!network.api.isConnected) {
        console.log(`[Dotsama] Resumming network [${network.specName}]`);
        await network.api.connect();
      }
    }));
  }
}
