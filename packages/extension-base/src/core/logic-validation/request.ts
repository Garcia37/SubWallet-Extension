// Copyright 2019-2022 @subwallet/extension-base
// SPDX-License-Identifier: Apache-2.0

import { TransactionError } from '@subwallet/extension-base/background/errors/TransactionError';
import { BasicTxErrorType, EvmSendTransactionParams, EvmSignatureRequest } from '@subwallet/extension-base/background/KoniTypes';
import { AccountJson } from '@subwallet/extension-base/background/types';
import KoniState from '@subwallet/extension-base/koni/background/handlers/State';
import { calculateGasFeeParams } from '@subwallet/extension-base/services/fee-service/utils';
import { AuthUrlInfo } from '@subwallet/extension-base/services/request-service/types';
import { createPromiseHandler, isSameAddress, stripUrl, wait } from '@subwallet/extension-base/utils';
import { KeyringPair } from '@subwallet/keyring/types';
import { keyring } from '@subwallet/ui-keyring';
import { getSdkError } from '@walletconnect/utils';
import BigN from 'bignumber.js';
import BN from 'bn.js';
import { t } from 'i18next';
import { TransactionConfig } from 'web3-core';

import { assert, isString } from '@polkadot/util';
import { isEthereumAddress } from '@polkadot/util-crypto';

export type ValidateStepFunction = (this: KoniState, url: string, payload: PayloadValidated, topic?: string) => Promise<PayloadValidated>

export interface PayloadValidated {
  networkKey?: string,
  address: string,
  pair?: KeyringPair,
  authInfo?: AuthUrlInfo,
  method?: string,
  payloadAfterValidated: any,
  errors: Error[]
}

export interface TransactionValidate {
  transaction: TransactionConfig;
  estimateGas: string;
  account: AccountJson;
}

export async function generateValidationProcess (this: KoniState, url: string, payloadValidate: PayloadValidated, validationMiddlewareSteps: ValidateStepFunction[], topic?: string): Promise<PayloadValidated> {
  let resultValidated = payloadValidate;

  for (let i = 0; i < validationMiddlewareSteps.length;) {
    resultValidated = await validationMiddlewareSteps[i].bind(this)(url, resultValidated, topic);
    i++;
  }

  return resultValidated;
}

export async function validationAuthMiddleware (this: KoniState, url: string, payload: PayloadValidated): Promise<PayloadValidated> {
  let keypair: KeyringPair | undefined;
  const { address } = payload;

  if (!address || !isString(address)) {
    throw new Error('Not found address to sign');
  } else {
    keypair = keyring.getPair(address);
    assert(keypair, t('Unable to find account'));

    const authList = await this.getAuthList();

    const authInfo = authList[stripUrl(url)];

    if (!authInfo || !authInfo.isAllowed || !authInfo.isAllowedMap[keypair.address]) {
      throw new Error('Account {{address}} not in allowed list'.replace('{{address}}', address));
    }

    payload.authInfo = authInfo;
    payload.pair = keypair;
  }

  return payload;
}

export async function validationConnectMiddleware (this: KoniState, url: string, payload: PayloadValidated): Promise<PayloadValidated> {
  let currentChain: string | undefined;
  let autoActiveChain = false;
  let { authInfo, networkKey } = { ...payload };

  if (!networkKey) {
    if (url) {
      if (authInfo?.currentEvmNetworkKey) {
        currentChain = authInfo?.currentEvmNetworkKey;
      }

      if (authInfo?.isAllowed) {
        autoActiveChain = true;
      }
    }

    const currentEvmNetwork = this.requestService.getDAppChainInfo({
      autoActive: autoActiveChain,
      accessType: 'evm',
      defaultChain: currentChain,
      url
    });

    if (currentEvmNetwork) {
      networkKey = currentEvmNetwork.slug;
    } else {
      throw new Error('No network to connect');
    }
  }

  const chainStatus = this.getChainStateByKey(networkKey);
  const chainInfo = this.getChainInfo(networkKey);

  if (!chainStatus.active) {
    try {
      await this.chainService.enableChain(networkKey);
    } catch (e) {
      throw new Error(getSdkError('USER_REJECTED').message + ' Can not active chain: ' + chainInfo.name);
    }
  }

  return {
    ...payload,
    networkKey
  };
}

export async function validationEvmDataTransactionMiddleware (this: KoniState, url: string, payload: PayloadValidated): Promise<PayloadValidated> {
  const errors: Error[] = payload.errors || [];
  let estimateGas = '';
  const transactionParams = payload.payloadAfterValidated as EvmSendTransactionParams;
  const { address: fromAddress, networkKey, pair } = payload;
  const evmApi = this.getEvmApi(networkKey || '');
  const web3 = evmApi?.api;

  const autoFormatNumber = (val?: string | number): string | undefined => {
    if (typeof val === 'string' && val.startsWith('0x')) {
      return new BN(val.replace('0x', ''), 16).toString();
    } else if (typeof val === 'number') {
      return val.toString();
    }

    return val;
  };

  const transaction: TransactionConfig = {
    from: transactionParams.from,
    to: transactionParams.to,
    value: autoFormatNumber(transactionParams.value),
    gas: autoFormatNumber(transactionParams.gas),
    gasPrice: autoFormatNumber(transactionParams.gasPrice || transactionParams.gasLimit),
    maxPriorityFeePerGas: autoFormatNumber(transactionParams.maxPriorityFeePerGas),
    maxFeePerGas: autoFormatNumber(transactionParams.maxFeePerGas),
    data: transactionParams.data
  };

  if (transaction.from === transaction.to) {
    errors.push(new TransactionError(BasicTxErrorType.INVALID_PARAMS, t('Receiving address must be different from sending address')));
  }

  // Address is validated in before step

  if (!fromAddress) {
    errors.push(new TransactionError(BasicTxErrorType.INVALID_PARAMS, t('You have rescinded allowance for this account in wallet')));
  }

  if (!transaction.gas) {
    const getTransactionGas = async () => {
      try {
        transaction.gas = await web3.eth.estimateGas({ ...transaction });
      } catch (e) {
        // @ts-ignore
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        errors.push(new TransactionError(BasicTxErrorType.INVALID_PARAMS, e?.message));
      }
    };

    // Calculate transaction data
    try {
      await Promise.race([
        getTransactionGas(),
        wait(3000).then(async () => {
          if (!transaction.gas) {
            await this.chainService.initSingleApi(networkKey || '');
            await getTransactionGas();
          }
        })
      ]);
    } catch (e) {
      // @ts-ignore
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR, e?.message));
    }
  }

  if (!transaction.gas) {
    errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR));
  } else {
    if (transactionParams.maxPriorityFeePerGas && transactionParams.maxFeePerGas) {
      const maxFee = new BigN(transactionParams.maxFeePerGas);

      estimateGas = maxFee.multipliedBy(transaction.gas).toFixed(0);
    } else if (transactionParams.gasPrice) {
      estimateGas = new BigN(transactionParams.gasPrice).multipliedBy(transaction.gas).toFixed(0);
    } else {
      try {
        const priority = await calculateGasFeeParams(evmApi, networkKey || '');

        if (priority.baseGasFee) {
          transaction.maxPriorityFeePerGas = priority.maxPriorityFeePerGas.toString();
          transaction.maxFeePerGas = priority.maxFeePerGas.toString();

          const maxFee = priority.maxFeePerGas;

          estimateGas = maxFee.multipliedBy(transaction.gas).toFixed(0);
        } else {
          transaction.gasPrice = priority.gasPrice;
          estimateGas = new BigN(priority.gasPrice).multipliedBy(transaction.gas).toFixed(0);
        }
      } catch (e) {
        errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR, (e as Error)?.message));
      }
    }

    try {
      // Validate balance
      const balance = new BN(await web3.eth.getBalance(fromAddress) || 0);

      if (!estimateGas) {
        errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR, t('Can\'t calculate estimate gas fee')));
      } else if (balance.lt(new BN(estimateGas).add(new BN(autoFormatNumber(transactionParams.value) || '0')))) {
        errors.push(new TransactionError(BasicTxErrorType.NOT_ENOUGH_BALANCE, t('Insufficient balance')));
      }
    } catch (e) {
      errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR, (e as Error).message));
    }
  }

  const pair_ = pair || keyring.getPair(fromAddress);
  const account: AccountJson = { address: fromAddress, ...pair_?.meta };

  try {
    transaction.nonce = await web3.eth.getTransactionCount(fromAddress);
  } catch (e) {
    errors.push(new TransactionError(BasicTxErrorType.INTERNAL_ERROR, (e as Error).message));
  }

  return {
    ...payload,
    errors,
    payloadAfterValidated: {
      transaction,
      account,
      estimateGas
    }
  };
}

export async function validationEvmSignMessageMiddleware (this: KoniState, url: string, payload_: PayloadValidated): Promise<PayloadValidated> {
  const { address, errors, method, pair: pair_ } = payload_;
  let payload = payload_.payloadAfterValidated as string;
  const { promise, resolve } = createPromiseHandler<PayloadValidated>();
  let hashPayload = '';
  let canSign = false;

  if (address === '' || !payload) {
    errors.push(new Error('Not found address or payload to sign'));
  }

  const pair = pair_ || keyring.getPair(address);

  const account: AccountJson = { address: pair.address, ...pair.meta };

  if (method) {
    if (['eth_sign', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4'].indexOf(method) < 0) {
      errors.push(new Error('Unsupported action'));
    }

    if (['eth_signTypedData_v3', 'eth_signTypedData_v4'].indexOf(method) > -1) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument,@typescript-eslint/no-unsafe-assignment
      payload = JSON.parse(payload);
    }

    switch (method) {
      case 'personal_sign':
        canSign = true;
        hashPayload = payload;
        break;
      case 'eth_sign':
      case 'eth_signTypedData':
      case 'eth_signTypedData_v1':
      case 'eth_signTypedData_v3':
      case 'eth_signTypedData_v4':
        if (!account.isExternal) {
          canSign = true;
        }

        break;
      default:
        errors.push(new Error('Unsupported action'));
    }
  } else {
    errors.push(new Error('Unsupported method'));
  }

  const payloadAfterValidated: EvmSignatureRequest = {
    account: account,
    type: method || '',
    payload: payload as unknown,
    hashPayload: hashPayload,
    canSign: canSign,
    id: ''
  };

  resolve(
    {
      ...payload_,
      errors,
      payloadAfterValidated
    }
  );

  return promise;
}

export function validationAuthWCMiddleware (this: KoniState, url: string, payload: PayloadValidated, topic?: string): Promise<PayloadValidated> {
  if (!topic) {
    throw new Error(getSdkError('UNAUTHORIZED_EXTEND_REQUEST').message);
  }

  const { promise, reject, resolve } = createPromiseHandler<PayloadValidated>();
  const { address } = payload;
  const requestSession = this.walletConnectService.getSession(topic);
  let sessionAccounts: string[] = [];

  if (isEthereumAddress(address)) {
    sessionAccounts = requestSession.namespaces.eip155.accounts?.map((account) => account.split(':')[2]) || sessionAccounts;
  } else {
    sessionAccounts = requestSession.namespaces.polkadot.accounts?.map((account) => account.split(':')[2]) || sessionAccounts;
  }

  let keypair: KeyringPair | undefined;

  if (!address || !isString(address)) {
    reject(new Error(getSdkError('UNSUPPORTED_ACCOUNTS').message + ' ' + address));
  } else {
    keypair = keyring.getPair(address);
    assert(keypair, t('Unable to find account'));

    const isExitsAccount = sessionAccounts.find((account) => isSameAddress(account, address));

    if (!isExitsAccount) {
      reject(new Error(getSdkError('UNSUPPORTED_ACCOUNTS').message + ' ' + address));
    }

    resolve(payload);
  }

  return promise;
}
