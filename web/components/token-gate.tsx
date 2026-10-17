import { Button, Card, Description, InputGroup, Label, TextField } from "@heroui/react";
import { ArrowRight, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";

export function TokenGate({ onSubmit }: { onSubmit: (token: string) => void }) {
	const [value, setValue] = useState("");

	return (
		<Card className="mx-auto w-full max-w-md">
			<Card.Header className="items-center text-center">
				<div className="mb-2 flex size-12 items-center justify-center rounded-2xl bg-accent/10 text-accent">
					<ShieldCheck className="size-6" />
				</div>
				<Card.Title className="text-lg">Connect to your bucket</Card.Title>
				<Card.Description>Enter the API token you set with <code>wrangler secret put API_TOKEN</code>.</Card.Description>
			</Card.Header>
			<Card.Content>
				<form
					className="flex flex-col gap-4"
					onSubmit={(e) => {
						e.preventDefault();
						if (value.trim()) onSubmit(value.trim());
					}}
				>
					<TextField type="password" value={value} onChange={setValue} isRequired autoFocus>
						<Label>API token</Label>
						<InputGroup>
							<InputGroup.Prefix>
								<KeyRound className="size-4 text-muted" />
							</InputGroup.Prefix>
							<InputGroup.Input placeholder="Paste your token" autoComplete="off" />
						</InputGroup>
						<Description>Stored only in this browser.</Description>
					</TextField>
					<Button type="submit" variant="primary" fullWidth isDisabled={!value.trim()}>
						Continue
						<ArrowRight className="size-4" />
					</Button>
				</form>
			</Card.Content>
		</Card>
	);
}
