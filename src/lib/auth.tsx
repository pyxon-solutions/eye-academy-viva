import { onAuthStateChanged, type User } from "firebase/auth";
import { useEffect, useState } from "react";
import { firebase } from "./firebase";

export function useUser(): { user: User | null; loading: boolean } {
	const [state, setState] = useState<{ user: User | null; loading: boolean }>({
		user: null,
		loading: true,
	});
	useEffect(
		() => onAuthStateChanged(firebase().auth, (user) => setState({ user, loading: false })),
		[],
	);
	return state;
}

export async function idToken(): Promise<string> {
	const user = firebase().auth.currentUser;
	if (!user) throw new Error("Not signed in");
	return user.getIdToken();
}
