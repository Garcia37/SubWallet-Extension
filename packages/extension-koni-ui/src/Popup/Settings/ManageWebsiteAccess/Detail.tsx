// Copyright 2019-2022 @polkadot/extension-ui authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { AuthUrlInfo } from '@subwallet/extension-base/background/handlers/State';
import { AccountJson } from '@subwallet/extension-base/background/types';
import AccountItemWithName from '@subwallet/extension-koni-ui/components/Account/Item/AccountItemWithName';
import PageWrapper from '@subwallet/extension-koni-ui/components/Layout/PageWrapper';
import { ActionItemType, ActionModal } from '@subwallet/extension-koni-ui/components/Modal/ActionModal';
import { changeAuthorization, changeAuthorizationPerAccount, forgetSite, toggleAuthorization } from '@subwallet/extension-koni-ui/messaging';
import { RootState } from '@subwallet/extension-koni-ui/stores';
import { updateAuthUrls } from '@subwallet/extension-koni-ui/stores/utils';
import { Theme, ThemeProps } from '@subwallet/extension-koni-ui/types';
import { ManageWebsiteAccessDetailParam } from '@subwallet/extension-koni-ui/types/navigation';
import { filterNotReadOnlyAccount } from '@subwallet/extension-koni-ui/util/account';
import { Icon, Switch, SwList, SwSubHeader } from '@subwallet/react-ui';
import { ModalContext } from '@subwallet/react-ui/es/sw-modal/provider';
import { GearSix, Plugs, PlugsConnected, ShieldCheck, ShieldSlash, X } from 'phosphor-react';
import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { NavigateFunction } from 'react-router/dist/lib/hooks';
import { useLocation, useNavigate } from 'react-router-dom';
import styled, { useTheme } from 'styled-components';

import { isEthereumAddress } from '@polkadot/util-crypto';

type Props = ThemeProps & ManageWebsiteAccessDetailParam & {
  authInfo: AuthUrlInfo;
  navigate: NavigateFunction;
};

type WrapperProps = ThemeProps;

const ActionModalId = 'actionModalId';
// const FilterModalId = 'filterModalId';

function Component ({ accountAuthType, authInfo, className = '', navigate, origin, siteName }: Props): React.ReactElement<Props> {
  const accounts = useSelector((state: RootState) => state.accountState.accounts);
  const [pendingMap, setPendingMap] = useState<Record<string, boolean>>({});
  const { activeModal, inactiveModal } = useContext(ModalContext);
  const { t } = useTranslation();
  const { token } = useTheme() as Theme;
  const accountItems = useMemo(() => {
    const accountListWithoutAll = filterNotReadOnlyAccount(accounts.filter((opt) => opt.address !== 'ALL'));

    if (accountAuthType === 'substrate') {
      return accountListWithoutAll.filter((acc) => !isEthereumAddress(acc.address));
    } else if (accountAuthType === 'evm') {
      return accountListWithoutAll.filter((acc) => isEthereumAddress(acc.address));
    } else {
      return accountListWithoutAll;
    }
  }, [accountAuthType, accounts]);

  const onBack = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const onOpenActionModal = useCallback(() => {
    activeModal(ActionModalId);
  }, [activeModal]);

  const onCloseActionModal = useCallback(() => {
    inactiveModal(ActionModalId);
  }, [inactiveModal]);

  const actions: ActionItemType[] = useMemo(() => {
    const isAllowed = authInfo.isAllowed;

    const result: ActionItemType[] = [
      {
        key: isAllowed ? 'block' : 'unblock',
        icon: isAllowed ? ShieldSlash : ShieldCheck,
        iconBackgroundColor: isAllowed ? token.colorError : token.colorSuccess,
        title: isAllowed ? t('Block this site') : t('Unblock this site'),
        onClick: () => {
          toggleAuthorization(origin)
            .then(({ list }) => {
              updateAuthUrls(list);
            })
            .catch(console.error);
          onCloseActionModal();
        }
      },
      {
        key: 'forget-site',
        icon: X,
        iconBackgroundColor: token.colorWarning,
        title: t('Forget site'),
        onClick: () => {
          forgetSite(origin, updateAuthUrls).catch(console.error);
          onCloseActionModal();
        }
      }
    ];

    if (isAllowed) {
      result.push(
        {
          key: 'disconnect-all',
          icon: Plugs,
          iconBackgroundColor: token['gray-3'],
          title: t('Disconnect all'),
          onClick: () => {
            changeAuthorization(false, origin, updateAuthUrls).catch(console.error);
            onCloseActionModal();
          }
        },
        {
          key: 'connect-all',
          icon: PlugsConnected,
          iconBackgroundColor: token['green-6'],
          title: t('Connect all'),
          onClick: () => {
            changeAuthorization(true, origin, updateAuthUrls).catch(console.error);
            onCloseActionModal();
          }
        }
      );
    }

    return result;
  }, [authInfo.isAllowed, onCloseActionModal, origin, t, token]);

  const renderItem = useCallback((item: AccountJson) => {
    const isEnabled: boolean = authInfo.isAllowedMap[item.address];

    const onClick = () => {
      setPendingMap((prevMap) => {
        return {
          ...prevMap,
          [item.address]: !isEnabled
        };
      });
      changeAuthorizationPerAccount(item.address, !isEnabled, origin, updateAuthUrls)
        .catch(console.log)
        .finally(() => {
          setPendingMap((prevMap) => {
            const newMap = { ...prevMap };

            delete newMap[item.address];

            return newMap;
          });
        });
    };

    return (
      <AccountItemWithName
        accountName={item.name}
        address={item.address}
        avatarSize={token.sizeLG}
        key={item.address}
        rightItem={(
          <Switch
            checked={pendingMap[item.address] === undefined ? isEnabled : pendingMap[item.address]}
            disabled={!authInfo.isAllowed || pendingMap[item.address] !== undefined}
            {...{ onClick }}
            style={{ marginRight: 8 }}
          />
        )}
      />
    );
  }, [authInfo.isAllowed, authInfo.isAllowedMap, origin, pendingMap, token.sizeLG]);

  const searchFunc = useCallback((item: AccountJson, searchText: string) => {
    const searchTextLowerCase = searchText.toLowerCase();

    return (
      item.address.toLowerCase().includes(searchTextLowerCase) ||
      (item.name
        ? item.name.toLowerCase().includes(searchTextLowerCase)
        : false)
    );
  }, []);

  useEffect(() => {
    setPendingMap((prevMap) => {
      if (!Object.keys(prevMap).length) {
        return prevMap;
      }

      return {};
    });
  }, [authInfo]);

  return (
    <PageWrapper className={`manage-website-access-detail ${className}`}>
      <SwSubHeader
        background={'transparent'}
        center
        onBack={onBack}
        paddingVertical
        rightButtons={[
          {
            icon: (
              <Icon
                customSize={'24px'}
                phosphorIcon={GearSix}
                type='phosphor'
                weight={'bold'}
              />
            ),
            onClick: onOpenActionModal
          }
        ]}
        showBackButton
        title={siteName}
      />

      <SwList.Section
        displayRow
        enableSearchInput
        list={accountItems}
        renderItem={renderItem}
        rowGap = {'8px'}
        searchFunction={searchFunc}
        searchMinCharactersCount={2}
        searchPlaceholder={t('Search account')} // todo: i18n this
      />

      <ActionModal
        actions={actions}
        className={`${className} action-modal`}
        id={ActionModalId}
        onCancel={onCloseActionModal}
        title={t('Website access config')}
      />
    </PageWrapper>
  );
}

function WrapperComponent (props: WrapperProps) {
  const location = useLocation();
  const { accountAuthType, origin, siteName } = location.state as ManageWebsiteAccessDetailParam;
  const authInfo: undefined | AuthUrlInfo = useSelector((state: RootState) => state.settings.authUrls[origin]);
  const navigate = useNavigate();

  useEffect(() => {
    if (!authInfo) {
      navigate(-1);
    }
  }, [navigate, authInfo]);

  return (
    <>
      {!!authInfo && (
        <Component
          {...props}
          accountAuthType={accountAuthType}
          authInfo={authInfo}
          navigate={navigate}
          origin={origin}
          siteName={siteName}
        />)}
    </>
  );
}

const ManageWebsiteAccessDetail = styled(WrapperComponent)<Props>(({ theme: { token } }: Props) => {
  return ({
    '&.manage-website-access-detail': {
      height: '100%',
      backgroundColor: token.colorBgDefault,
      display: 'flex',
      flexDirection: 'column',

      '.ant-sw-list-section': {
        flex: 1
      }
    },

    '&.action-modal': {
      '.__action-item.block .ant-setting-item-name': {
        color: token.colorError
      }
    }
  });
});

export default ManageWebsiteAccessDetail;
