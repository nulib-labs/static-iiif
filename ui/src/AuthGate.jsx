import {useCallback, useEffect, useState} from "react";
import {getCurrentUser, signOut as amplifySignOut} from "aws-amplify/auth";
import {Flex, Spinner} from "@radix-ui/themes";
import SignIn from "./components/SignIn";

// Replaces Amplify's <Authenticator>: holds just enough session state to decide
// between the sign-in screen and the app. Tokens stay in Amplify's own storage —
// nothing about the credentials is kept here.
export default function AuthGate({children}) {
  const [status, setStatus] = useState("checking"); // checking | signedOut | signedIn

  const refresh = useCallback(async () => {
    try {
      await getCurrentUser();
      setStatus("signedIn");
    } catch {
      // No cached session — expected on a first visit or after sign-out.
      setStatus("signedOut");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await amplifySignOut();
    } finally {
      setStatus("signedOut");
    }
  }, []);

  if (status === "checking") {
    return (
      <Flex align="center" justify="center" style={{minHeight: "100vh"}}>
        <Spinner size="3" />
      </Flex>
    );
  }

  if (status === "signedOut") {
    return <SignIn onSignedIn={refresh} />;
  }

  return children({signOut});
}
